// SPDX-FileCopyrightText: 2026 Jiří Rýdel <it@jrydel.cz>
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {REQUEST_TIMEOUT_SECONDS, resolveCommand, exitReason, parseUsage} from './usage.js';

const CONTRACT_URL = 'https://github.com/jrydel/burnline#json-contract';

export default class BurnlinePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const group = new Adw.PreferencesGroup({
            title: 'Usage source',
            description: `Burnline runs a command and reads the usage JSON it prints. Any program that prints the <a href="${CONTRACT_URL}">documented shape</a> works; the default, <tt>omp usage --json</tt>, reads what Oh My Pi has already fetched for its signed-in accounts.`,
        });

        const command = new Adw.EntryRow({title: 'Usage command'});
        settings.bind('usage-command', command, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(command);

        const interval = new Adw.SpinRow({
            title: 'Refresh every',
            adjustment: new Gtk.Adjustment({lower: 15, upper: 3600, step_increment: 15, page_increment: 60}),
            numeric: true,
        });
        interval.add_suffix(new Gtk.Label({label: 'seconds', css_classes: ['dim-label']}));
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        // Output of the command lands in the subtitle verbatim, so no markup.
        const test = new Adw.ActionRow({title: 'Test command', subtitle: 'Runs the usage command once and reports what came back.', use_markup: false});
        const button = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        test.add_suffix(button);
        test.activatable_widget = button;
        button.connect('clicked', () => this._test(settings, test, button));
        group.add(test);

        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);
    }

    // The same resolution, flags, timeout, and parsing as the extension, so a
    // passing test is a working panel. Every failure becomes subtitle text.
    _test(settings, row, button) {
        const report = text => {
            row.subtitle = text;
            button.sensitive = true;
        };
        button.sensitive = false;
        row.subtitle = 'Running…';
        let process;
        try {
            const argv = resolveCommand(settings.get_string('usage-command'));
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            report(error.message);
            return;
        }
        const cancellable = new Gio.Cancellable();
        let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_SECONDS, () => {
            timeout = 0;
            cancellable.cancel();
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        process.communicate_utf8_async(null, cancellable, (proc, result) => {
            const timedOut = !timeout;
            if (timeout) GLib.Source.remove(timeout);
            timeout = 0;
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                const reason = exitReason(proc);
                // A failing command usually says why on stderr; keep its first line.
                const detail = stderr?.trim().split('\n')[0];
                if (reason) throw new Error(detail ? `${reason}: ${detail}` : reason);
                const data = parseUsage(stdout);
                const providers = data.filter(provider => provider.accounts.length).length;
                const limits = data.flatMap(provider => provider.accounts).reduce((count, account) => count + account.limits.length, 0);
                report(`Returned ${limits} limits across ${providers} providers`);
            } catch (error) {
                report(timedOut ? `no answer in ${REQUEST_TIMEOUT_SECONDS}s` : error.message);
            }
        });
    }
}
