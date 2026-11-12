/**
 * Desktop notification and sound when a compilation ends (optional: pawnStudio.notify.*).
 * Uses what the system already has: a Windows toast + system sounds through PowerShell,
 * osascript/afplay on macOS, notify-send/paplay on Linux. Nothing is installed.
 */
import * as cp from 'child_process';

export interface NotifyOptions {
    desktop: boolean;
    sound: boolean;
}

function spawnQuiet(cmd: string, args: string[], env?: NodeJS.ProcessEnv): void {
    try {
        const p = cp.spawn(cmd, args, { windowsHide: true, detached: false, stdio: 'ignore', env: { ...process.env, ...env } });
        p.on('error', () => undefined);
        p.unref();
    } catch {
        /* no notifier on this system */
    }
}

/** Shows the notification and/or plays the sound. `ok` picks the success or the error sound. */
export function notify(ok: boolean, title: string, body: string, o: NotifyOptions): void {
    if (!o.desktop && !o.sound) return;
    if (process.platform === 'win32') {
        // the text goes through environment variables, so no quoting problem with any character
        const script = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            o.desktop
                ? [
                      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
                      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
                      "$x = $t.GetElementsByTagName('text')",
                      '$x.Item(0).AppendChild($t.CreateTextNode($env:PAWN_TITLE)) > $null',
                      '$x.Item(1).AppendChild($t.CreateTextNode($env:PAWN_BODY)) > $null',
                      // the sound (if any) is played below, the same one for every notification
                      "$a = $t.CreateElement('audio'); $a.SetAttribute('silent', 'true'); $t.DocumentElement.AppendChild($a) > $null",
                      '$n = [Windows.UI.Notifications.ToastNotification]::new($t)',
                      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)",
                  ].join('; ')
                : '',
            o.sound ? `[System.Media.SystemSounds]::${ok ? 'Asterisk' : 'Hand'}.Play(); Start-Sleep -Milliseconds 900` : '',
        ]
            .filter(Boolean)
            .join('; ');
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        spawnQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { PAWN_TITLE: title, PAWN_BODY: body });
        return;
    }
    if (process.platform === 'darwin') {
        const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        if (o.desktop) spawnQuiet('osascript', ['-e', `display notification "${q(body)}" with title "${q(title)}"`]);
        if (o.sound) spawnQuiet('afplay', [ok ? '/System/Library/Sounds/Glass.aiff' : '/System/Library/Sounds/Basso.aiff']);
        return;
    }
    if (o.desktop) spawnQuiet('notify-send', ['-a', 'Pawn Studio', title, body]);
    if (o.sound) spawnQuiet('paplay', [ok ? '/usr/share/sounds/freedesktop/stereo/complete.oga' : '/usr/share/sounds/freedesktop/stereo/dialog-error.oga']);
}
