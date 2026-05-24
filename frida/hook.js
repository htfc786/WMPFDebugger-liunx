const isWindows = Process.platform === "windows";

const getMainModule = (version) => {
    if (!isWindows) {
        return Process.findModuleByName("WeChatAppEx");
    }
    if (version >= 13331) {
        return Process.findModuleByName("flue.dll");
    }
    return Process.findModuleByName("WeChatAppEx.exe");
};

const patchCDPFilter = (base, config) => {
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    const offset = config.CDPFilterHookOffset;
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            if (!args[0].isNull()) {
                send(
                    `[patch] CDP filter on enter, original value of input: ${args[0].readPointer()}`,
                );
            }
        },
        onLeave(retval) {
            // On Linux, patch the return value directly: caller checks [rax+8] == 6
            if (retval.isNull()) {
                return;
            }
            send(
                `[patch] CDP filter on leave, retval: ${retval}; ` +
                    `*(retval + 8) = ${retval.add(8).readU32()}`,
            );
            if (retval.add(8).readU32() == 6) {
                retval.add(8).writeU32(0x0);
            }
        },
    });
};

const hookOnLoadScene = (a1, sceneOffsets) => {
    const miniappConfigPtr = a1
        .add(sceneOffsets[0])
        .readPointer()
        .add(sceneOffsets[1])
        .readPointer();
    const miniappScenePtr = miniappConfigPtr
        .add(sceneOffsets[2])
        .readPointer()
        .add(sceneOffsets[3])
        .readPointer()
        .add(sceneOffsets[4])
        .readPointer()
        .add(sceneOffsets[5]);
    send(`[hook] scene: ${miniappScenePtr.readInt()}`);

    // 1000: from issue #83 <-- will crash the process
    // 1007: from issue #80
    // 1008: from issue #53
    // 1027: from issue #78
    // 1035: from issue #78
    // 1053: from issue #25
    // 1074: from issue #32
    // 1145: from search
    // 1178: from phone (issue #117)
    // 1256: from recent
    // 1260: from frequently used
    // 1302: from services
    // 1308: minigame?
    const sceneNumberArray = [
        1005, 1007, 1008, 1027, 1035, 1053, 1074, 1145, 1178, 1256, 1260, 1302,
        1308,
    ];
    if (!sceneNumberArray.includes(miniappScenePtr.readInt())) {
        return;
    }
    send("[hook] hook scene condition -> 1101");
    miniappScenePtr.writeInt(1101);

    // TODO: customize debugging endpoint
    // const websocketServerStringPtr = passArgs.add(8).readPointer().add(520);
    // VERBOSE && console.log("[hook] hook websocket server, original: ", websocketServerStringPtr.readUtf8String());
    // websocketServerStringPtr.writeUtf8String("ws://127.0.0.1:8189/");
};

const patchOnLoadStart = (base, config) => {
    // xref: AppletIndexContainer::OnLoadStart
    // Windows: rcx=this, rdx=is_main_frame
    // Linux:   rdi=this, rsi=is_main_frame
    Interceptor.attach(base.add(config.LoadStartHookOffset), {
        onEnter(args) {
            const thisPtr = isWindows ? this.context.rcx : this.context.rdi;
            const isMainFrameReg = isWindows ? this.context.rdx : this.context.rsi;

            send(
                `[inteceptor] AppletIndexContainer::OnLoadStart onEnter, ` +
                    `indexContainer.this: ${thisPtr}`,
            );
            // write dl/sil to 0x1 (force is_main_frame = true)
            if ((isMainFrameReg & 0xff) !== 1) {
                if (isWindows) {
                    this.context.rdx = (this.context.rdx & ~0xff) | 0x1;
                } else {
                    this.context.rsi = (this.context.rsi & ~0xff) | 0x1;
                }
            }
            // handle onLoad scene
            hookOnLoadScene(thisPtr, config.SceneOffsets);
        },
        onLeave(retval) {
            // do nothing
        },
    });
};

const parseConfig = () => {
    const rawConfig = `@@CONFIG@@`;
    if (rawConfig.includes("@@")) {
        // test addresses (Windows fallback)
        if (isWindows) {
            return {
                Version: 18955,
                LoadStartHookOffset: "0x25B52C0",
                CDPFilterHookOffset: "0x30248B0",
                SceneOffsets: [1408, 1344, 488],
            };
        }
        // Linux fallback
        return {
            Version: "linux",
            LoadStartHookOffset: "0x8320180",
            CDPFilterHookOffset: "0xBCAAC90",
            SceneOffsets: [1360, 1312, 488],
        };
    }
    return JSON.parse(rawConfig);
};

const main = () => {
    const config = parseConfig();
    const mainModule = getMainModule(config.Version);
    patchOnLoadStart(mainModule.base, config);
    patchCDPFilter(mainModule.base, config);
};

main();
