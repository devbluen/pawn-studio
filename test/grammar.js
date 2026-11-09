// Grammar test: tokenizes a SA-MP sample with vscode-textmate and checks scopes.
// Usage: node test/grammar.js   (pass --dump to print every token)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const GRAMMAR = path.join(__dirname, '..', 'syntaxes', 'pawn.tmLanguage.json');
const WASM = path.join(path.dirname(require.resolve('vscode-oniguruma')), 'onig.wasm');

const SAMPLE = String.raw`#include <a_samp>
#tryinclude "modules/util.inc"
#define MAX_HOUSES (500)
#define IsValidHouse(%0) \
	((%0) >= 0 && (%0) < MAX_HOUSES)
#if defined _inc_player
	#endinput
#endif
#pragma tabsize 4

/**
 * Dados do jogador. TODO: mover para outro modulo
 */
enum E_PLAYER_DATA {
	E_PLAYER_NAME[MAX_PLAYER_NAME],
	Float:E_PLAYER_HEALTH,
	bool:E_PLAYER_LOGGED
}
new PlayerData[MAX_PLAYERS][E_PLAYER_DATA];
new Text:gClock;
/// Converte hexadecimal
forward Float:GetDistance(Float:x, Float:y);
native IsValidVehicle(vehicleid);

/* comentario
   multi-linha */
main()
{
	print("Gamemode carregado");
}

public OnPlayerConnect(playerid)
{
	new name[MAX_PLAYER_NAME], msg[128];
	GetPlayerName(playerid, name, sizeof name);
	format(msg, sizeof msg, "{FF0000}%s entrou (id %d, %.2f%%)\n", name, playerid, 1.5);
	SendClientMessageToAll(-1, msg);
	new admin = IsPlayerAdmin(playerid) ? 1 : 0;
	new Float:hp = 100.0, mask = 0xFF_FF, flags = 0b1010, big = 1_000_000, sci = 1.0e5;
	new packed[] = !"packed";
	new raw[] = \"C:\path";
	new c = 'a', t = '\n';
	new MyTag:tagged = MyTag:0, alt = admin ? hp:mask;
	switch (admin)
	{
		case 0: SendClientMessage(playerid, INVALID_PLAYER_ID, "x");
		case 1, 2: return 1;
		default: {}
	}
	return true;
}

hook OnPlayerSpawn(playerid)
{
	foreach (new i : Player)
	{
		SetPlayerPos(i, 0.0, 0.0, 3.0);
	}
	return 1;
}

stock Float:GetDistance(Float:x, Float:y)
{
	return floatsqroot(x * x + y * y);
}

timer RespawnTimer[1000](playerid) { SpawnPlayer(playerid); }

CMD:ajuda(playerid, params[])
{
	return @CustomFunc(playerid);
}

stock Defaults(amount = MAX_PLAYERS, const reason[] = "a;b", {Float,_}:...)
{
	#emit LOAD.S.pri amount
	return amount;
}
static const gNames[][] = {"a", "b"};
desc:ban("Bans a player")
flags:ban(CMD_ADMIN | CMD_MOD)
alias:ban("banir", "b")
new tern = cond ? value:Func(1);
Inventario:usarRoupa(playerid, modelo)
{
	return Inventario:Abrir(playerid);
}
	PhoneAlert:Notas(playerid, button) {
	}
`;

async function main() {
  const wasm = fs.readFileSync(WASM).buffer;
  await oniguruma.loadWASM(wasm);
  const onigLib = Promise.resolve({
    createOnigScanner: (p) => new oniguruma.OnigScanner(p),
    createOnigString: (s) => new oniguruma.OnigString(s)
  });
  const registry = new vsctm.Registry({
    onigLib,
    loadGrammar: async (scope) =>
      scope === 'source.pawn' ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR) : null
  });
  const grammar = await registry.loadGrammar('source.pawn');
  assert.ok(grammar, 'grammar failed to load');

  const lines = SAMPLE.split(/\r?\n/);
  const tokens = []; // { line, text, scopes }
  let stack = vsctm.INITIAL;
  lines.forEach((line, i) => {
    const r = grammar.tokenizeLine(line, stack);
    for (const t of r.tokens) {
      tokens.push({ line: i, text: line.substring(t.startIndex, t.endIndex), scopes: t.scopes });
    }
    stack = r.ruleStack;
  });

  if (process.argv.includes('--dump')) {
    for (const t of tokens) console.log(t.line + 1, JSON.stringify(t.text), t.scopes.slice(1).join(' '));
  }

  let n = 0;
  // expect(lineContains, tokenText, scopeSubstring, nth = 0)
  const expect = (lineSnippet, text, scope, nth = 0) => {
    const li = lines.findIndex((l) => l.includes(lineSnippet));
    assert.ok(li >= 0, `sample line not found: ${lineSnippet}`);
    const found = tokens.filter((t) => t.line === li && t.text.trim() === text);
    const tok = found[nth];
    assert.ok(tok, `token ${JSON.stringify(text)} (#${nth}) not found on line ${li + 1}: ${lines[li]}`);
    const ok = tok.scopes.some((s) => s === scope || s.startsWith(scope + '.') || s.startsWith(scope));
    assert.ok(ok, `line ${li + 1} token ${JSON.stringify(text)}: expected "${scope}", got [${tok.scopes.join(', ')}]`);
    n++;
  };
  const notScope = (lineSnippet, text, scope, nth = 0) => {
    const li = lines.findIndex((l) => l.includes(lineSnippet));
    const tok = tokens.filter((t) => t.line === li && t.text.trim() === text)[nth];
    assert.ok(tok, `token ${JSON.stringify(text)} not found on line ${li + 1}`);
    assert.ok(!tok.scopes.some((s) => s.startsWith(scope)),
      `line ${li + 1} token ${JSON.stringify(text)}: must not be "${scope}", got [${tok.scopes.join(', ')}]`);
    n++;
  };

  // preprocessor
  expect('#include <a_samp>', '#', 'punctuation.definition.directive');
  expect('#include <a_samp>', 'include', 'keyword.control.directive.include');
  expect('#include <a_samp>', 'a_samp', 'string.quoted.other.lt-gt.include');
  expect('#tryinclude', 'modules/util.inc', 'string.quoted.double.include');
  expect('#define MAX_HOUSES', 'MAX_HOUSES', 'variable.other.constant.preprocessor');
  expect('#define IsValidHouse', 'IsValidHouse', 'entity.name.function.preprocessor');
  expect('#define IsValidHouse', '%0', 'variable.parameter.preprocessor');
  expect('#define IsValidHouse', '\\', 'constant.character.escape.line-continuation');
  expect('((%0) >= 0', '%0', 'variable.parameter.preprocessor', 1); // continued line (2nd)
  expect('((%0) >= 0', '%0', 'meta.preprocessor.macro');
  expect('#if defined', 'defined', 'keyword.operator.defined');
  expect('#endinput', 'endinput', 'keyword.control.directive.endinput');
  expect('#pragma', 'tabsize', 'entity.other.attribute-name.pragma');

  // comments
  expect(' * Dados do jogador', 'TODO:', 'comment.todo');
  expect(' * Dados do jogador', 'TODO:', 'comment.block.documentation');
  expect('/// Converte', '/// Converte hexadecimal'.slice(3).trim(), 'comment.block.documentation');
  expect('multi-linha */', 'multi-linha', 'comment.block.pawn');
  notScope('main()', 'main', 'comment');

  // enum
  expect('enum E_PLAYER_DATA', 'enum', 'storage.type.enum');
  expect('enum E_PLAYER_DATA', 'E_PLAYER_DATA', 'entity.name.type.enum');
  expect('E_PLAYER_NAME[MAX', 'E_PLAYER_NAME', 'variable.other.enummember');
  expect('E_PLAYER_NAME[MAX', 'MAX_PLAYER_NAME', 'variable.other.constant');
  expect('Float:E_PLAYER_HEALTH', 'Float:', 'support.type.tag');
  expect('Float:E_PLAYER_HEALTH', 'E_PLAYER_HEALTH', 'variable.other.enummember');
  expect('bool:E_PLAYER_LOGGED', 'bool:', 'support.type.tag');

  // declarations / tags
  expect('new PlayerData', 'new', 'storage.type');
  expect('new PlayerData', 'MAX_PLAYERS', 'variable.other.constant');
  expect('new Text:gClock', 'Text:', 'support.type.tag');
  expect('forward Float:GetDistance', 'forward', 'storage.modifier');
  expect('forward Float:GetDistance', 'Float:', 'support.type.tag');
  expect('forward Float:GetDistance', 'GetDistance', 'entity.name.function');
  expect('native IsValidVehicle', 'IsValidVehicle', 'entity.name.function');
  expect('main()', 'main', 'entity.name.function');
  expect('public OnPlayerConnect', 'public', 'storage.modifier');
  expect('public OnPlayerConnect', 'OnPlayerConnect', 'entity.name.function.callback');
  expect('stock Float:GetDistance', 'stock', 'storage.modifier');
  expect('stock Float:GetDistance', 'GetDistance', 'entity.name.function');

  // calls
  expect('print("Gamemode', 'print', 'support.function');
  expect('GetPlayerName(playerid', 'GetPlayerName', 'support.function');
  expect('GetPlayerName(playerid', 'sizeof', 'keyword.operator.sizeof');
  expect('return floatsqroot', 'floatsqroot', 'support.function');
  expect('return @CustomFunc', '@CustomFunc', 'entity.name.function');

  // strings / format
  expect('format(msg', '{FF0000}', 'constant.other.color');
  expect('format(msg', '%s', 'constant.other.placeholder');
  expect('format(msg', '%d', 'constant.other.placeholder');
  expect('format(msg', '%.2f', 'constant.other.placeholder');
  expect('format(msg', '%%', 'constant.character.escape');
  expect('format(msg', '\\n', 'constant.character.escape');
  expect('format(msg', 'entrou (id', 'string.quoted.double.pawn');
  expect('!"packed"', '!', 'storage.modifier.string.packed');
  expect('!"packed"', 'packed', 'string.quoted.double.packed', 1);
  expect('\\"C:\\path"', 'C:\\path', 'string.quoted.double.raw');
  expect("new c = 'a'", 'a', 'string.quoted.single');
  expect("new c = 'a'", '\\n', 'constant.character.escape');

  // ternary — "1 : 0" must not be a tag
  expect('? 1 : 0', '?', 'keyword.operator.ternary');
  expect('? 1 : 0', ':', 'keyword.operator.ternary');
  expect('? 1 : 0', '0', 'constant.numeric.decimal');

  // generic tags vs. compact ternary
  expect('new MyTag:tagged', 'MyTag:', 'entity.name.type.tag');
  expect('new MyTag:tagged', 'MyTag:', 'entity.name.type.tag', 1);
  notScope('new MyTag:tagged', 'hp', 'entity.name.type.tag');
  expect('new MyTag:tagged', ':', 'keyword.operator.ternary');

  // numbers
  expect('new Float:hp', '100.0', 'constant.numeric.float');
  expect('new Float:hp', '0xFF_FF', 'constant.numeric.hex');
  expect('new Float:hp', '0b1010', 'constant.numeric.binary');
  expect('new Float:hp', '1_000_000', 'constant.numeric.decimal');
  expect('new Float:hp', '1.0e5', 'constant.numeric.float');
  expect('new Float:hp', 'Float:', 'support.type.tag');

  // switch / case / default
  expect('case 0: SendClientMessage', 'case', 'keyword.control');
  expect('case 0: SendClientMessage', ':', 'punctuation.separator.case');
  notScope('case 0: SendClientMessage', '0', 'entity.name.type.tag');
  expect('case 0: SendClientMessage', 'SendClientMessage', 'support.function');
  expect('case 0: SendClientMessage', 'INVALID_PLAYER_ID', 'variable.other.constant');
  expect('case 1, 2: return', 'return', 'keyword.control');
  expect('default: {}', 'default', 'keyword.control');
  expect('default: {}', ':', 'punctuation.separator.case');
  expect('return true;', 'true', 'constant.language.boolean');

  // YSI
  expect('hook OnPlayerSpawn', 'hook', 'storage.modifier.hook');
  expect('hook OnPlayerSpawn', 'OnPlayerSpawn', 'entity.name.function.callback');
  expect('foreach (new i : Player)', 'foreach', 'keyword.other');
  expect('foreach (new i : Player)', 'new', 'storage.type');
  notScope('foreach (new i : Player)', 'i', 'entity.name.type.tag');
  expect('foreach (new i : Player)', 'Player', 'variable.other');

  expect('timer RespawnTimer', 'timer', 'storage.modifier.timer');
  expect('timer RespawnTimer', 'RespawnTimer', 'entity.name.function');

  // commands
  expect('CMD:ajuda', 'CMD', 'storage.modifier.prefix');
  expect('CMD:ajuda', 'ajuda', 'entity.name.function');

  // calls: always entity.name.function.call (natives keep support.function outside)
  expect('GetPlayerName(playerid', 'GetPlayerName', 'entity.name.function.call');
  expect('SetPlayerPos(i, 0.0', 'SetPlayerPos', 'entity.name.function.call');

  // parameters of declarations
  expect('public OnPlayerConnect', 'playerid', 'variable.parameter');
  expect('stock Float:GetDistance', 'x', 'variable.parameter');
  expect('stock Float:GetDistance', 'Float:', 'support.type.tag', 1);
  expect('timer RespawnTimer', 'playerid', 'variable.parameter');
  expect('CMD:ajuda', 'params', 'variable.parameter');
  expect('stock Defaults(', 'amount', 'variable.parameter');
  expect('stock Defaults(', 'MAX_PLAYERS', 'variable.other.constant'); // default value is not a parameter
  expect('stock Defaults(', 'reason', 'variable.parameter');
  expect('stock Defaults(', 'const', 'storage.modifier');
  expect('stock Defaults(', '...', 'variable.parameter.variadic');
  notScope('GetPlayerName(playerid', 'playerid', 'variable.parameter');

  // arrays are not functions
  notScope('static const gNames[][]', 'gNames', 'entity.name.function');
  expect('static const gNames[][]', 'b', 'string.quoted.double');

  // preprocessor details
  expect('#if defined _inc_player', '_inc_player', 'variable.other.constant.preprocessor');
  expect('#emit LOAD.S.pri', 'LOAD.S.pri', 'entity.name.function.opcode');

  // command attributes: same prefix color as CMD:, arguments are normal code
  expect('desc:ban(', 'desc', 'storage.modifier.prefix');
  expect('desc:ban(', 'ban', 'entity.name.function.command');
  expect('desc:ban(', 'Bans a player', 'string.quoted.double');
  expect('flags:ban(', 'flags', 'storage.modifier.prefix');
  expect('flags:ban(', 'CMD_ADMIN', 'variable.other.constant');
  notScope('flags:ban(', 'CMD_ADMIN', 'variable.parameter');
  expect('flags:ban(', '|', 'keyword.operator.bitwise');
  expect('alias:ban(', 'banir', 'string.quoted.double');
  notScope('new tern = cond', 'value', 'storage.modifier.prefix');
  expect('new tern = cond', 'Func', 'entity.name.function.call');

  // prefix macros starting a definition line: same color as CMD:
  expect('Inventario:usarRoupa(', 'Inventario', 'storage.modifier.prefix');
  expect('Inventario:usarRoupa(', 'modelo', 'variable.parameter');
  expect('PhoneAlert:Notas(', 'PhoneAlert', 'storage.modifier.prefix');
  expect('PhoneAlert:Notas(', 'button', 'variable.parameter');
  notScope('return Inventario:Abrir', 'Inventario:', 'storage.modifier.prefix'); // a call, not a definition
  notScope('return Inventario:Abrir', 'playerid', 'variable.parameter');
  expect('stock Float:GetDistance', 'Float:', 'support.type.tag');

  // the last line must have closed every scope
  assert.strictEqual(stack.depth, 1, 'rule stack not empty at end of sample (unclosed scope)');
  n++;

  console.log(`${n} grammar assertions passed`);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
