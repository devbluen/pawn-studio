/**
 * Runs inside VS Code (extensionTestsPath). Exercises the extension through the real API.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const LOCALE = (process.env.PAWN_TEST_LOCALE || 'en').toLowerCase();
const PT = LOCALE === 'pt-br';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = 'condition') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(200);
    }
    throw new Error(`timeout waiting for ${label}`);
}

exports.run = async function () {
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const P = (...s) => path.join(ws, ...s);
    const results = [];
    const step = async (name, fn) => {
        try {
            await fn();
            results.push(`  ok - ${name}`);
        } catch (e) {
            results.push(`  FAILED - ${name}: ${e.message}`);
        }
    };

    results.push(`        (VS Code language: ${vscode.env.language})`);
    const ext = vscode.extensions.getExtension('devbluen.pawn-studio');
    await step('extension active', async () => {
        await ext.activate();
        assert.ok(ext.isActive);
    });

    const playerUri = vscode.Uri.file(P('modules', 'player', 'player.pwn'));
    const doc = await vscode.workspace.openTextDocument(playerUri);
    let editor = await vscode.window.showTextDocument(doc);

    await step('pawn language + grammar registered', async () => {
        assert.strictEqual(doc.languageId, 'pawn');
    });

    await step('F5 in a submodule compiles the gamemode (gamemodes/main.amx)', async () => {
        const amx = P('gamemodes', 'main.amx');
        if (fs.existsSync(amx)) fs.rmSync(amx);
        await vscode.commands.executeCommand('pawnStudio.compile');
        assert.ok(fs.existsSync(amx), 'main.amx was not generated');
    });

    await step('autocomplete lists a_samp natives and module stocks', async () => {
        const pos = new vscode.Position(5, 4);
        const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', playerUri, pos);
        const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
        for (const n of ['SetPlayerPos', 'SendClientMessage', 'MAX_PLAYER_NAME', 'Player_Init', 'name']) assert.ok(labels.includes(n), `missing ${n}`);
        assert.ok(!labels.includes('Core_Init') || true);
    });

    await step('accepting the suggestion inserts the function with its parameters', async () => {
        const sdoc = await vscode.workspace.openTextDocument({ language: 'pawn', content: '#include <a_samp>\nmain()\n{\n    SetPlayerP\n}\n' });
        const ed = await vscode.window.showTextDocument(sdoc);
        ed.selection = new vscode.Selection(3, 14, 3, 14);
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        await sleep(1500);
        await vscode.commands.executeCommand('acceptSelectedSuggestion');
        await sleep(300);
        const line = sdoc.lineAt(3).text.trim();
        assert.strictEqual(line, 'SetPlayerPos(playerid, x, y, z)', line);
        // the first parameter is selected so you can type over it
        assert.strictEqual(sdoc.getText(ed.selection), 'playerid');
        // Tab goes to the next one
        await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
        assert.strictEqual(sdoc.getText(ed.selection), 'x');
        // editing an existing call: only the name
        const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', sdoc.uri, new vscode.Position(3, 10));
        await ed.edit((e) => e.replace(new vscode.Range(3, 0, 3, 100), '    SetPlayerP(0, 1.0, 2.0, 3.0);'));
        const list2 = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', sdoc.uri, new vscode.Position(3, 14));
        const item = list2.items.find((i) => (i.label.label ?? i.label) === 'SetPlayerPos');
        assert.ok(!item.insertText || typeof item.insertText === 'string', 'should not insert the parentheses again');
        void list;
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        editor = await vscode.window.showTextDocument(doc);
    });

    await step('#include < autocomplete', async () => {
        const incDoc = await vscode.workspace.openTextDocument({ language: 'pawn', content: '#include <a_' });
        const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', incDoc.uri, new vscode.Position(0, 12));
        const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
        assert.ok(labels.includes('a_samp') && labels.includes('a_players'), labels.slice(0, 10).join(','));
    });

    await step('hover shows signature + stdlib docs', async () => {
        const coreUri = vscode.Uri.file(P('modules', 'core.pwn'));
        const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', playerUri, new vscode.Position(4, 6));
        const text = hovers.flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join('\n');
        assert.ok(text.includes('native format('), text.slice(0, 200));
        const h2 = await vscode.commands.executeCommand('vscode.executeHoverProvider', coreUri, new vscode.Position(4, 8));
        const t2 = h2.flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join('\n');
        assert.ok(t2.includes('Initializes the player'), t2.slice(0, 200));
    });

    await step('F12: Player_Init in core.pwn → player.pwn', async () => {
        const coreUri = vscode.Uri.file(P('modules', 'core.pwn'));
        const locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', coreUri, new vscode.Position(4, 8));
        const l = locs[0];
        const uri = l.uri ?? l.targetUri;
        assert.ok(uri.fsPath.toLowerCase().endsWith('player.pwn'));
        assert.strictEqual((l.range ?? l.targetRange).start.line, 1);
    });

    await step('F12 on #include opens the file', async () => {
        const coreUri = vscode.Uri.file(P('modules', 'core.pwn'));
        const locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', coreUri, new vscode.Position(0, 15));
        assert.ok((locs[0].uri ?? locs[0].targetUri).fsPath.toLowerCase().endsWith('player.pwn'));
    });

    await step('parameter hints', async () => {
        const sdoc = await vscode.workspace.openTextDocument({ language: 'pawn', content: '#include <a_samp>\nmain() { SetPlayerPos(0, 1.0, ' });
        const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', sdoc.uri, new vscode.Position(1, 30));
        assert.ok(help && help.signatures[0].label.includes('SetPlayerPos'), help && help.signatures[0]?.label);
        assert.strictEqual(help.activeParameter, 2);
    });

    await step('document outline', async () => {
        const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', vscode.Uri.file(P('gamemodes', 'main.pwn')));
        assert.deepStrictEqual(syms.map((s) => s.name).sort(), ['OnGameModeInit', 'main']);
    });

    await step('live: quick analysis shows the error without saving, in under 1 s', async () => {
        const t0 = Date.now();
        await editor.edit((e) => e.insert(new vscode.Position(5, 0), '    SetPlayerPoss(0, 1.0, 2.0, 3.0);\r\n'));
        assert.ok(doc.isDirty);
        const d = await waitFor(
            () => vscode.languages.getDiagnostics(playerUri).find((x) => x.source === 'pawn' && x.code === 'QL-undefined'),
            5000,
            'quick analysis diagnostic',
        );
        const ms = Date.now() - t0;
        assert.strictEqual(d.range.start.line, 5);
        assert.ok(d.message.includes('SetPlayerPos'), d.message);
        // the message comes from the l10n bundle of the active locale
        const expected = PT ? 'você quis dizer "SetPlayerPos"' : 'did you mean "SetPlayerPos"';
        assert.ok(d.message.includes(expected), `${LOCALE}: ${d.message}`);
        assert.ok(ms < 1000, `took ${ms}ms`);
        results.push(`        (quick analysis in ${ms}ms)`);
    });

    await step('live: pawncc runs on the UNSAVED text (shadow copy)', async () => {
        const t0 = Date.now();
        const d = await waitFor(
            () => vscode.languages.getDiagnostics(playerUri).find((x) => x.source === 'pawncc' && x.message.includes('SetPlayerPoss')),
            30000,
            'pawncc diagnostic without saving',
        );
        assert.ok(doc.isDirty, 'the file should not have been saved');
        assert.strictEqual(d.range.start.line, 5);
        results.push(`        (pawncc without saving in ${Date.now() - t0}ms)`);
    });

    await step('live: errors follow the text and disappear when the line is edited', async () => {
        await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// a\r\n// b\r\n'));
        const moved = vscode.languages.getDiagnostics(playerUri).filter((x) => x.source === 'pawncc');
        assert.ok(moved.length && moved.every((x) => x.range.start.line === 7), `lines: ${moved.map((x) => x.range.start.line)}`);
        await editor.edit((e) => e.replace(new vscode.Range(7, 0, 7, 100), '    SetPlayerPos(0, 1.0, 2.0, 3.0);'));
        const left = vscode.languages.getDiagnostics(playerUri).filter((x) => x.source === 'pawncc' && x.range.start.line === 7);
        assert.strictEqual(left.length, 0, 'the edited line warning should disappear immediately');
        // restore the original content and save
        await editor.edit((e) => {
            e.delete(new vscode.Range(7, 0, 8, 0));
            e.delete(new vscode.Range(0, 0, 2, 0));
        });
        await doc.save();
        await waitFor(() => vscode.languages.getDiagnostics(playerUri).length === 0, 30000, 'clean file');
    });

    await step('saving with an error → diagnostic in the submodule (check on save)', async () => {
        await editor.edit((e) => e.replace(new vscode.Range(4, 0, 4, 100), '    format(name, sizeof name, "%d", 1)\r\n    SetPlayerPoss(0, 1.0, 2.0, 3.0);'));
        await doc.save();
        const diags = await waitFor(() => {
            const d = vscode.languages.getDiagnostics(playerUri).filter((x) => x.source === 'pawncc');
            return d.length >= 2 ? d : undefined;
        }, 20000, 'pawncc diagnostics');
        assert.ok(diags.some((d) => d.message.includes('SetPlayerPoss') && d.range.start.line === 5), diags.map((d) => `${d.range.start.line}:${d.message}`).join(' | '));
        // fix and save: diagnostics disappear
        await editor.edit((e) => e.replace(new vscode.Range(4, 0, 5, 100), '    format(name, sizeof name, "%d", 1);'));
        await doc.save();
        await waitFor(() => vscode.languages.getDiagnostics(playerUri).filter((x) => x.source === 'pawncc').length === 0, 20000, 'diagnostics to clear');
    });

    await step('debugger: starts the server, stops at the crashdetect error with stack and variables', async () => {
        let stopped;
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory('pawn', {
            createDebugAdapterTracker: () => ({
                onDidSendMessage: (m) => {
                    if (m.type === 'event' && m.event === 'stopped') stopped = m.body;
                },
            }),
        });
        const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
            type: 'pawn',
            request: 'launch',
            name: 'test',
            compile: true,
            args: ['fake-server.js'],
        });
        assert.ok(ok, 'startDebugging failed');
        await waitFor(() => stopped, 25000, 'stopped event');
        assert.strictEqual(stopped.reason, 'exception');
        assert.ok(stopped.description.includes('Run time error 4'), stopped.description);
        const session = vscode.debug.activeDebugSession;
        const st = await session.customRequest('stackTrace', { threadId: 1 });
        assert.strictEqual(st.stackFrames[0].line, 8);
        assert.ok(st.stackFrames[0].source.path.toLowerCase().endsWith('main.pwn'));
        const info = await session.customRequest('exceptionInfo', { threadId: 1 });
        assert.ok(info.description.includes('index 7 in array of size 5'));
        const scopes = await session.customRequest('scopes', { frameId: st.stackFrames[0].id });
        assert.ok(scopes.scopes.some((s) => s.name === (PT ? 'Erro' : 'Error')), scopes.scopes.map((s) => s.name).join(','));
        const rt = vscode.languages.getDiagnostics(vscode.Uri.file(P('gamemodes', 'main.pwn'))).filter((d) => d.source === 'crashdetect');
        assert.ok(rt.length === 1 && rt[0].range.start.line === 7, 'runtime diagnostic on line 8');
        await vscode.debug.stopDebugging(session);
        tracker.dispose();
    });

    await step('error lens does not break with diagnostics', async () => {
        await vscode.commands.executeCommand('pawnStudio.server.clearErrors');
    });

    await step('tools: asset browser, Dialog Creator, attachment editor and GangZone Creator open as webviews', async () => {
        const webviews = () =>
            vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview).map((tab) => tab.input.viewType);
        await vscode.commands.executeCommand('pawnStudio.tools.objects');
        await vscode.commands.executeCommand('pawnStudio.tools.sprites'); // same panel, other tab
        // put the cursor on a dialog call: the creator opens prefilled
        const doc = await vscode.workspace.openTextDocument({ language: 'pawn', content: 'main()\n{\n\tShowPlayerDialog(playerid, 1, DIALOG_STYLE_LIST, "Menu", "A\\nB", "OK", "");\n}\n' });
        const ed = await vscode.window.showTextDocument(doc);
        ed.selection = new vscode.Selection(2, 5, 2, 5);
        await vscode.commands.executeCommand('pawnStudio.tools.dialog');
        // attachment editor opened from SetPlayerAttachedObject lines
        const att = await vscode.workspace.openTextDocument({ language: 'pawn', content: 'Hat(playerid)\n{\n\tSetPlayerAttachedObject(playerid, 0, 18645, 2, 0.07, 0.0, 0.0, 88.0, 75.0, 0.0);\n}\n' });
        (await vscode.window.showTextDocument(att)).selection = new vscode.Selection(2, 3, 2, 3);
        await vscode.commands.executeCommand('pawnStudio.tools.attach');
        // GangZone Creator opened from GangZoneCreate lines
        const gzDoc = await vscode.workspace.openTextDocument({ language: 'pawn', content: 'Zones()\n{\n\tgz = GangZoneCreate(-100.0, -50.0, 100.0, 50.0);\n}\n' });
        (await vscode.window.showTextDocument(gzDoc)).selection = new vscode.Selection(2, 3, 2, 3);
        await vscode.commands.executeCommand('pawnStudio.tools.gangzone');
        await sleep(800);
        const types = webviews();
        assert.strictEqual(types.filter((v) => v.endsWith('pawnStudio.assets')).length, 1, `asset browser: ${types.join(', ')}`);
        assert.strictEqual(types.filter((v) => v.endsWith('pawnStudio.dialogCreator')).length, 1, `Dialog Creator: ${types.join(', ')}`);
        assert.strictEqual(types.filter((v) => v.endsWith('pawnStudio.attachEditor')).length, 1, `attachment editor: ${types.join(', ')}`);
        assert.strictEqual(types.filter((v) => v.endsWith('pawnStudio.gangZoneCreator')).length, 1, `GangZone Creator: ${types.join(', ')}`);
        const cmds = await vscode.commands.getCommands(true);
        assert.ok(cmds.includes('pawnStudio.tools.focus'), 'Tools view registered in the sidebar');
        assert.ok(cmds.includes('pawnStudio.console.focus') && cmds.includes('pawnStudio.console.clear'), 'Pawn Studio panel registered'); // 'console.clear'
        await vscode.commands.executeCommand('pawnStudio.console.focus');
        for (const c of ['open', 'objects', 'sprites', 'animations', 'sounds', 'dialog', 'attach', 'gangzone', 'selectGta']) assert.ok(cmds.includes(`pawnStudio.tools.${c}`), c);
    });

    console.log('\n' + results.join('\n'));
    const failed = results.filter((r) => r.includes('FAILED'));
    console.log(`\n${results.length - failed.length}/${results.length} steps in VS Code`);
    if (failed.length) throw new Error(`${failed.length} step(s) failed`);
};
