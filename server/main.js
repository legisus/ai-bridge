// Entry point of the single-executable build (scripts/build-sea.js bundles this
// file). One binary, dispatched on the first argument:
//
//   ai-bridge serve                    relay server (what the native host starts)
//   ai-bridge host                     native messaging host (Chrome passes a
//   ai-bridge chrome-extension://…/    chrome-extension:// origin instead of "host")
//   ai-bridge register-host [flags]    write the native host manifest for this binary
//   ai-bridge <cmd> [params] [flags]   the CLI (ping, listTabs, eval, agent, …)
const a = process.argv[2] || "";
if (a === "serve") require("./server").start();
else if (a === "host" || /^chrome-extension:\/\//.test(a)) require("./native-host").main();
else if (a === "register-host") require("./register-native-host").main(process.argv.slice(3));
else require("./cli").main(process.argv.slice(2));
