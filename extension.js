// SPDX-FileCopyrightText: 2026 Jiří Rýdel <it@jrydel.cz>
// SPDX-License-Identifier: GPL-2.0-or-later

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {PROVIDERS, STALE_MS, REQUEST_TIMEOUT_SECONDS, resolveCommand, exitReason, parseUsage, normalizeUsage, remainingPercent, remainingText, countdown, freshness, threshold, paceFraction} from './usage.js';

const COUNTDOWN_SECONDS = 15;
// The preferences entry writes the command on every keystroke; let the line
// settle before launching it.
const SETTLE_MS = 1000;
// Continuous rounded rail in the Quick Settings slider idiom: 8px inside a
// 12px surface so the pace notch can overshoot it top and bottom.
const RAIL_HEIGHT = 8;
// Notch suppressed this close to either end, where it would read as a broken
// rail cap rather than a mark on the window.
const NOTCH_MARGIN = 7;
const TRACK = [1, 1, 1, 0.10];
const PACE = [0.9451, 0.9412, 0.9255, 0.55];
const AMBER = '#E3A93F';
const EMBER = '#DE6B5E';
const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
const label = (text, style = '', extra = {}) => new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER, ...extra});
const box = (vertical = false, style = '', extra = {}) => new St.BoxLayout({orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL, style_class: style, ...extra});
const everyText = seconds => seconds === 3600 ? 'every hour' : seconds === 60 ? 'every minute' : seconds % 60 ? `every ${seconds}s` : `every ${seconds / 60} minutes`;
const roundedRect = (cr, x, y, w, h, r) => {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
};

export default class Burnline extends Extension {
    enable() {
        this._active = true;
        this._generation = (this._generation || 0) + 1;
        this._data = normalizeUsage({reports: []});
        this._error = false;
        this._loaded = false;
        this._process = null;
        this._cancellable = null;
        this._requestTimeout = 0;
        this._settleTimer = 0;
        this._rows = [];
        this._panelValues = [];
        this._settings = this.getSettings();
        this._settingsHandlers = [
            this._settings.connect('changed::usage-command', () => this._scheduleFetch()),
            this._settings.connect('changed::refresh-interval', () => {
                this._startRefreshTimer();
                this._scheduleFetch();
            }),
        ];
        this._indicator = new PanelMenu.Button(0.0, 'AI usage: Claude and OpenAI', false);
        this._indicator.add_style_class_name('burnline-indicator');
        const panel = box(false, 'burnline-panel');
        PROVIDERS.forEach((provider, index) => {
            if (index) panel.add_child(new St.Widget({style_class: 'burnline-panel-divider', y_align: Clutter.ActorAlign.CENTER}));
            const group = box(false, 'burnline-panel-provider');
            group.add_child(this._icon(provider, 16));
            const values = {};
            // Label and value are separate actors so the tokens can stay in the
            // UI sans while the digits use tabular mono.
            for (const window of ['5h', '7d']) {
                if (window === '7d') group.add_child(label('·', 'burnline-panel-token'));
                group.add_child(label(window, 'burnline-panel-token'));
                values[window] = label('—', 'burnline-panel-value');
                group.add_child(values[window]);
            }
            this._panelValues.push(values);
            panel.add_child(group);
        });
        this._health = new St.Widget({style_class: 'burnline-health-dot', y_align: Clutter.ActorAlign.CENTER, visible: false});
        panel.add_child(this._health);
        panel.add_child(new St.Icon({icon_name: 'pan-down-symbolic', icon_size: 10}));
        this._indicator.add_child(panel);
        this._indicator.menu.box.add_style_class_name('burnline-menu');
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._updateClocks();
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._render();
        this._startRefreshTimer();
        this._clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, COUNTDOWN_SECONDS, () => {
            this._updateClocks();
            return GLib.SOURCE_CONTINUE;
        });
        this._fetchUsage();
    }

    _icon(provider, size) {
        return new St.Icon({
            gicon: Gio.icon_new_for_string(`${this.path}/icons/${provider.icon}-symbolic.svg`),
            icon_size: size,
            style: `color: ${provider.color};`,
            style_class: 'burnline-provider-icon',
            accessible_name: provider.icon === 'anthropic' ? 'Anthropic' : 'OpenAI',
        });
    }

    _startRefreshTimer() {
        if (this._refreshTimer) GLib.Source.remove(this._refreshTimer);
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('refresh-interval'), () => {
            this._fetchUsage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // A settings change: once the line settles, drop any fetch of the old
    // command and start over with the new one.
    _scheduleFetch() {
        if (this._settleTimer) GLib.Source.remove(this._settleTimer);
        this._settleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleTimer = 0;
            this._abortFetch();
            this._fetchUsage();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Bumping the generation is what retires the pending callback: its result
    // never lands after the command that produced it is gone.
    _abortFetch() {
        this._generation++;
        if (this._requestTimeout) GLib.Source.remove(this._requestTimeout);
        this._requestTimeout = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._process?.force_exit();
        this._process = null;
    }

    _fetchUsage() {
        if (!this._active || this._process) return;
        let argv;
        try {
            argv = resolveCommand(this._settings.get_string('usage-command'));
        } catch (error) {
            this._error = true;
            this._errorMessage = error.code === 'missing'
                ? `Can't run ${error.program}. Set the usage command in Burnline's settings.`
                : "Usage command is not valid. Check Burnline's settings.";
            this._render();
            return;
        }
        const generation = this._generation;
        try {
            this._cancellable = new Gio.Cancellable();
            // No shell and no token access: the command prints the usage JSON
            // documented in the README, and nothing else of it is read.
            const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            this._process = process;
            this._requestTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_SECONDS, () => {
                this._requestTimeout = 0;
                this._cancellable?.cancel();
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            process.communicate_utf8_async(null, this._cancellable, (proc, result) => {
                if (!this._active || this._generation !== generation) return;
                // The timeout zeroes its own id before cancelling, so a zero
                // here means it fired.
                const timedOut = !this._requestTimeout;
                if (this._requestTimeout) GLib.Source.remove(this._requestTimeout);
                this._requestTimeout = 0;
                try {
                    const [, stdout] = proc.communicate_utf8_finish(result);
                    const reason = exitReason(proc);
                    if (reason) throw new Error(reason);
                    this._data = parseUsage(stdout);
                    this._loaded = true;
                    this._error = false;
                    this._lastSuccess = Date.now();
                } catch (error) {
                    // Keep the last successful values, visibly marked as stale.
                    this._fail(timedOut ? `no answer in ${REQUEST_TIMEOUT_SECONDS}s` : error.message);
                } finally {
                    this._process = null;
                    this._cancellable = null;
                    this._render();
                }
            });
        } catch (_error) {
            this._process = null;
            this._cancellable = null;
            this._fail("didn't start");
            this._render();
        }
    }

    _fail(reason) {
        this._error = true;
        this._errorMessage = `Usage command failed: ${reason}. Retrying ${everyText(this._settings.get_int('refresh-interval'))}.`;
    }

    // One grid for every quota row: elastic label, then two fixed columns whose
    // right edges are identical on every row and never move as text changes.
    _quotaRow(limit, provider, missingLabel) {
        const model = Boolean(limit?.model);
        const section = box(true, model ? 'burnline-model-row' : 'burnline-quota');
        const row = box(false, 'burnline-row');
        const labelBox = box(false, 'burnline-label-box', {x_expand: true});
        labelBox.add_child(label(limit?.label || missingLabel, 'burnline-row-label'));
        if (limit?.tag) labelBox.add_child(label(limit.tag, 'burnline-tag'));
        if (limit?.percent == null) labelBox.add_child(label('not reported', 'burnline-note'));
        row.add_child(labelBox);
        const reset = label(countdown(limit?.resetsAt), 'burnline-reset');
        row.add_child(reset);
        const state = threshold(limit?.percent, limit?.status);
        const value = label(remainingText(limit?.percent), `burnline-value burnline-${state}`);
        row.add_child(value);
        section.add_child(row);
        const entry = {reset, value, limit: limit || null, meter: null};
        this._rows.push(entry);
        // Model rows carry no rail of their own; a row with no data gets none
        // either, because an all-unlit rail would read as an empty tank when
        // the truth is that nothing was reported.
        if (model || limit?.percent == null) {
            this._describeRow(entry);
            return section;
        }
        // Depleting fuel gauge: the fill is the quota still left, measured from
        // the left edge, so the rail empties as the window burns. Painted
        // against the final surface allocation instead of sizing a child from
        // width/mapped notifications, which can precede layout on reopen.
        const meter = new St.DrawingArea({style_class: 'burnline-track', x_expand: true});
        const fill = rgb(state === 'critical' ? EMBER : state === 'warning' ? AMBER : provider.color);
        const fraction = (remainingPercent(limit?.percent) ?? 0) / 100;
        meter.connect('repaint', area => {
            const [width, height] = area.get_surface_size();
            const cr = area.get_context();
            if (width > 0 && height > 0) {
                const railHeight = Math.min(height, RAIL_HEIGHT);
                const railY = (height - railHeight) / 2;
                const radius = railHeight / 2;
                cr.setSourceRGBA(...TRACK);
                roundedRect(cr, 0, railY, width, railHeight, radius);
                cr.fill();
                const fillWidth = width * fraction;
                if (fillWidth > 0) {
                    cr.setSourceRGB(...fill);
                    // A remainder narrower than the rail's own diameter keeps
                    // a sane pill instead of self-intersecting arcs.
                    roundedRect(cr, 0, railY, fillWidth, railHeight, Math.min(radius, fillWidth / 2));
                    cr.fill();
                }
                // Even-pace notch: the quota an even burn would have left by
                // now, so a fill longer than the notch is ahead of pace. Cut
                // clean through the surface and hairline the gap, so the mark
                // reads against fill and track alike.
                const pace = paceFraction(limit);
                const notchX = pace === null ? null : (1 - pace) * width;
                if (notchX !== null && notchX > NOTCH_MARGIN && notchX < width - NOTCH_MARGIN) {
                    const gapX = Math.min(Math.max(0, notchX - 1), Math.max(0, width - 3));
                    cr.setOperator(Cairo.Operator.CLEAR);
                    cr.rectangle(gapX, 0, 3, height);
                    cr.fill();
                    cr.setOperator(Cairo.Operator.OVER);
                    cr.setSourceRGBA(PACE[0], PACE[1], PACE[2], 0.85);
                    cr.rectangle(gapX + 1, 0, 1, height);
                    cr.fill();
                }
            }
            cr.$dispose();
        });
        entry.meter = meter;
        this._describeRow(entry);
        section.add_child(meter);
        return section;
    }

    _describeRow({value, limit}) {
        if (limit?.status === 'exhausted') {
            value.accessible_name = 'Nothing left';
            return;
        }
        const left = remainingPercent(limit?.percent);
        if (left === null) {
            value.accessible_name = 'Not reported';
            return;
        }
        const pace = paceFraction(limit);
        const rate = pace === null ? '' : left / 100 > 1 - pace ? ', ahead of even pace' : ', on track to exhaust before reset';
        value.accessible_name = `${remainingText(limit.percent)} left${rate}`;
    }

    _render() {
        if (!this._active || !this._indicator) return;
        this._indicator.menu.removeAll();
        this._rows = [];
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const content = box(true, 'burnline-content', {x_expand: true});
        const heading = box(false, 'burnline-heading');
        heading.add_child(label('AI usage', 'burnline-title'));
        // Every value in the popup is quota left, said once as a chip.
        heading.add_child(label('% left', 'burnline-pill', {x_expand: true, x_align: Clutter.ActorAlign.START}));
        this._freshnessLabel = label('', 'burnline-freshness');
        heading.add_child(this._freshnessLabel);
        const refresh = new St.Button({style_class: 'burnline-icon-button', can_focus: true, accessible_name: 'Refresh usage', y_align: Clutter.ActorAlign.CENTER});
        refresh.set_child(new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16}));
        refresh.connect('clicked', () => this._fetchUsage());
        heading.add_child(refresh);
        content.add_child(heading);
        this._data.forEach((provider, index) => {
            const card = box(true, 'burnline-card', {x_expand: true});
            const providerHeading = box(false, 'burnline-provider-heading');
            providerHeading.add_child(this._icon(provider, 18));
            providerHeading.add_child(label(provider.name, 'burnline-provider-name'));
            if (provider.accounts.length > 1) providerHeading.add_child(label(`${provider.accounts.length} accounts`, 'burnline-note', {x_expand: true, x_align: Clutter.ActorAlign.END}));
            card.add_child(providerHeading);
            const accounts = provider.accounts.length ? provider.accounts : [{limits: []}];
            accounts.forEach((account, accountIndex) => {
                if (accounts.length > 1) card.add_child(label(`Account ${accountIndex + 1}`, 'burnline-account'));
                for (const window of ['5h', '7d']) {
                    const limit = account.limits.find(entry => entry.window === window && !entry.model);
                    card.add_child(this._quotaRow(limit, provider, window === '5h' ? '5-hour quota' : 'Weekly quota'));
                    for (const child of account.limits.filter(entry => entry.model && entry.window === window)) card.add_child(this._quotaRow(child, provider));
                }
            });
            content.add_child(card);
            this._panelValues[index]['5h'].text = remainingText(provider.fiveHour?.percent);
            this._panelValues[index]['7d'].text = remainingText(provider.weekly?.percent);
        });
        if (this._data.some(provider => provider.accounts.length > 1)) content.add_child(label('Top bar shows the busiest account.', 'burnline-caption'));
        this._footerLabel = label('', 'burnline-footer');
        content.add_child(this._footerLabel);
        item.add_child(content);
        // Keep long multi-account/model lists within the monitor.
        const scroll = new St.ScrollView({style_class: 'burnline-scroll', overlay_scrollbars: true});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const container = box(true);
        container.add_child(item);
        scroll.set_child(container);
        const scrolledItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        scrolledItem.add_child(scroll);
        this._indicator.menu.addMenuItem(scrolledItem);
        this._updateClocks();
    }

    _updateClocks() {
        if (!this._active) return;
        const now = Date.now();
        for (const entry of this._rows) {
            entry.reset.text = countdown(entry.limit?.resetsAt, now);
            this._describeRow(entry);
            entry.meter?.queue_repaint();
        }
        const interval = this._settings.get_int('refresh-interval');
        // A slow refresh must not read as stale data between two refreshes.
        const staleMs = Math.max(STALE_MS, 2 * interval * 1000);
        const reports = this._data.flatMap(provider => provider.accounts);
        const stale = this._error || reports.some(account => freshness(account.fetchedAt, now, staleMs));
        const empty = this._loaded ? this._data.filter(provider => !provider.accounts.some(account => account.limits.some(limit => limit.percent !== null))) : [];
        const fetched = reports.map(account => account.fetchedAt).filter(value => typeof value === 'number' && Number.isFinite(value));
        const lastUpdated = fetched.length ? Math.min(...fetched) : this._lastSuccess;
        const elapsed = lastUpdated ? Math.max(0, Math.floor((now - lastUpdated) / 60000)) : null;
        this._freshnessLabel.text = !this._loaded ? (this._error ? 'Unavailable' : 'Loading…') : stale ? 'Stale' : elapsed ? `Updated ${elapsed}m ago` : 'Updated just now';
        // One footer line: a fault when there is one, else the legend for the
        // notch every meter carries.
        this._footerLabel.text = this._error ? this._errorMessage
            : stale ? `Values older than ${Math.round(staleMs / 60000)} minutes. Refreshing ${everyText(interval)}.`
            : empty.length ? `No usage returned for ${empty[0].name}. Check its sign-in.`
            : 'Notch marks even pace through the window.';
        this._health.visible = stale || empty.length > 0;
        this._health.accessible_name = this._error ? this._errorMessage : stale ? 'Usage values are stale' : empty.length ? `No usage returned for ${empty[0].name}` : '';
        this._indicator.accessible_name = `AI usage. ${this._data.map(provider => `${provider.name}: five-hour ${remainingText(provider.fiveHour?.percent)} left, weekly ${remainingText(provider.weekly?.percent)} left`).join('. ')}${stale ? '. Data stale.' : ''}`;
    }

    disable() {
        this._active = false;
        for (const id of [this._refreshTimer, this._clockTimer, this._settleTimer]) if (id) GLib.Source.remove(id);
        this._refreshTimer = this._clockTimer = this._settleTimer = 0;
        this._abortFetch();
        for (const id of this._settingsHandlers ?? []) this._settings?.disconnect(id);
        this._settingsHandlers = [];
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._rows = [];
        this._panelValues = [];
        this._data = null;
        this._lastSuccess = null;
    }
}
