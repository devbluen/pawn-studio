/**
 * Test inside a real VS Code (downloads VS Code into .vscode-test the first time).
 *   node test/vscode/runTest.js <pawncc.exe> <include-folder> [<include-folder> ...]
 * Builds a test server in a temp folder with a fake "samp-server.exe"
 * (a copy of node.exe running fake-server.js) that writes a crashdetect error to the log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const argv = process.argv.slice(2);
    // --locale=pt-br runs the same suite with the Brazilian Portuguese bundle
    const localeArg = argv.find((a) => a.startsWith('--locale='));
    const locale = localeArg ? localeArg.split('=')[1] : 'en';
    // --auto: leave pawnStudio.language on "auto" so the extension follows the VS Code display language
    const auto = argv.includes('--auto');
    const [compiler, ...includes] = argv.filter((a) => a !== localeArg && a !== '--auto');
    if (!compiler) throw new Error('usage: node test/vscode/runTest.js <pawncc.exe> <include...>');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-vsc-'));
    const w = (rel, txt) => {
        const p = path.join(ws, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, txt);
        return p;
    };
    w('gamemodes/main.pwn', '#include <a_samp>\r\n#include "../modules/core.pwn"\r\n\r\nmain() { print("gm"); }\r\n\r\npublic OnGameModeInit()\r\n{\r\n    Core_Init();\r\n    return 1;\r\n}\r\n');
    w('modules/core.pwn', '#include "../modules/player/player.pwn"\r\n\r\nstock Core_Init()\r\n{\r\n    Player_Init();\r\n}\r\n');
    w('modules/player/player.pwn', '/// <summary>Initializes the player.</summary>\r\nstock Player_Init()\r\n{\r\n    new name[MAX_PLAYER_NAME];\r\n    format(name, sizeof name, "%d", 1);\r\n    print(name);\r\n}\r\n');
    w('server.cfg', 'echo Executing Server Config...\r\nrcon_password test123\r\nport 7777\r\ngamemode0 main 1\r\nplugins crashdetect\r\n');
    w('plugins/crashdetect.dll', '');
    // fake "server": renamed node.exe running fake-server.js
    fs.copyFileSync(process.execPath, path.join(ws, 'samp-server.exe'));
    const mainPwn = path.join(ws, 'gamemodes', 'main.pwn').replace(/\\/g, '\\\\');
    w(
        'fake-server.js',
        `const fs=require('fs');const log='server_log.txt';const a=(s)=>fs.appendFileSync(log,s+'\\r\\n');
a('[00:00:01] SA-MP Dedicated Server');a('[00:00:01] Loaded 1 filterscripts.');
setTimeout(()=>{a('[00:00:02] [debug] Run time error 4: "Array index out of bounds"');
a('[00:00:02] [debug]  Attempted to read/write array element at index 7 in array of size 5');
a('[00:00:02] [debug] AMX backtrace:');
a('[00:00:02] [debug] #0 00000a28 in public OnGameModeInit () at ${mainPwn}:8');
a('[00:00:02] [debug] #1 native CallLocalFunction () in samp-server.exe');a('[00:00:03] server tick');},1500);
setTimeout(()=>process.exit(0),60000);`,
    );
    w(
        '.vscode/settings.json',
        JSON.stringify(
            {
                'pawnStudio.compilerPath': compiler,
                'pawnStudio.includePaths': includes,
                'pawnStudio.packages.checkUpdatesOnStartup': false,
                'pawnStudio.revealOutput': 'never',
                'pawnStudio.lint.delay': 400,
                'pawnStudio.language': auto ? 'auto' : locale,
            },
            null,
            2,
        ),
    );
    console.log('test workspace:', ws);
    // --locale sets the VS Code display language (needs the language pack installed in .vscode-test
    // for non-English locales). Without --auto the extension's own setting forces the language too.
    const launchArgs = [ws, '--disable-extensions', '--disable-workspace-trust', `--locale=${locale}`];
    await runTests({
        extensionDevelopmentPath: path.resolve(__dirname, '../..'),
        extensionTestsPath: path.resolve(__dirname, 'suite.js'),
        launchArgs,
        extensionTestsEnv: { PAWN_TEST_LOCALE: locale },
    });
}

main().catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
});
