// SPDX-FileCopyrightText: 2026 Jiří Rýdel <it@jrydel.cz>
// SPDX-License-Identifier: GPL-2.0-or-later

// Shared by the extension and its preferences: locating the usage command,
// normalizing what it prints, and presenting the result. Holds no credentials
// and makes no provider requests; the configured command does that work.
import GLib from 'gi://GLib';

export const PROVIDERS = [
    {id: 'anthropic', name: 'Claude', icon: 'anthropic', color: '#D9825E'},
    {id: 'openai-codex', name: 'OpenAI', icon: 'openai', color: '#74C6A4'},
];
export const STALE_MS = 480000;
export const REQUEST_TIMEOUT_SECONDS = 35;
const WINDOW_MS = {'5h': 18000000, '7d': 604800000};
const sharedLabel = window => window === '5h' ? '5-hour quota' : 'Weekly quota';
const finite = value => typeof value === 'number' && Number.isFinite(value);

// A usage command that cannot be launched: `code` is 'invalid' when the line
// does not split like a shell word list, 'missing' when its program is not on
// PATH and not an executable file.
export class CommandError extends Error {
    constructor(code, program = null) {
        super(code === 'invalid' ? 'not a valid command line' : 'command not found');
        this.code = code;
        this.program = program;
    }
}

// Splits the configured line into argv with its program resolved, the one
// way the extension launches it, so the preferences test cannot disagree
// with what the panel runs. No shell is involved.
export function resolveCommand(command) {
    let argv;
    try {
        [, argv] = GLib.shell_parse_argv(command);
    } catch (_error) {
        throw new CommandError('invalid');
    }
    const [name, ...rest] = argv;
    const isFile = GLib.file_test(name, GLib.FileTest.IS_EXECUTABLE) && !GLib.file_test(name, GLib.FileTest.IS_DIR);
    const program = GLib.find_program_in_path(name) || (isFile ? name : null);
    if (!program) throw new CommandError('missing', name);
    return [program, ...rest];
}

// Why a finished usage command cannot be trusted, or null when it exited
// cleanly.
export function exitReason(process) {
    if (process.get_successful()) return null;
    return process.get_if_exited() ? `exited ${process.get_exit_status()}` : `killed by signal ${process.get_term_sig()}`;
}

// Usage command output to normalized providers. Throws with the reason both
// the popup footer and the preferences test show.
export function parseUsage(stdout) {
    let payload;
    try {
        payload = JSON.parse(stdout);
    } catch (_error) {
        throw new Error('invalid JSON');
    }
    return normalizeUsage(payload);
}

export function usedPercent(amount = {}) {
    let fraction;
    if (finite(amount.usedFraction)) fraction = amount.usedFraction;
    else if (finite(amount.used) && finite(amount.limit) && amount.limit > 0) fraction = amount.used / amount.limit;
    else if (amount.unit === 'percent' && finite(amount.used)) fraction = amount.used / 100;
    else if (finite(amount.remainingFraction)) fraction = 1 - amount.remainingFraction;
    else if (finite(amount.remaining) && finite(amount.limit) && amount.limit > 0) fraction = 1 - amount.remaining / amount.limit;
    return finite(fraction) ? Math.max(0, fraction * 100) : null;
}

export function windowId(limit) {
    const window = limit.window || {};
    if (['5h', '7d'].includes(window.id)) return window.id;
    if (['5h', '7d'].includes(limit.scope?.windowId)) return limit.scope.windowId;
    if (window.durationMs === WINDOW_MS['5h']) return '5h';
    if (window.durationMs === WINDOW_MS['7d']) return '7d';
    return null;
}

function modelName(limit) {
    const scope = limit.scope || {};
    const name = scope.modelId || scope.tier;
    if (!name || ['default', 'all', 'shared', 'standard'].includes(String(name).toLowerCase())) return null;
    const known = /\b(fable|sol|spark|opus|sonnet|haiku|astra|terra|luna)\b/i.exec(String(name));
    const result = known ? known[1] : String(name).replace(/^(claude-|gpt-)/i, '').replace(/-/g, ' ');
    return result.charAt(0).toUpperCase() + result.slice(1);
}

export function normalizeUsage(payload) {
    const reports = Array.isArray(payload) ? payload : payload?.reports;
    if (!Array.isArray(reports)) throw new Error('no reports array');
    return PROVIDERS.map(provider => {
        const found = reports.filter(report => report?.provider === provider.id && Array.isArray(report.limits));
        const accounts = found.map((report, index) => {
            const limits = report.limits.flatMap(limit => {
                if (!limit || typeof limit !== 'object') return [];
                const window = windowId(limit);
                if (!window) return [];
                const model = modelName(limit);
                return [{id: String(limit.id || `${model || 'shared'}:${window}`), window, model, tag: null,
                    label: model ? `${model} ${window === '5h' ? '5-hour' : 'weekly'}` : sharedLabel(window),
                    percent: usedPercent(limit.amount || {}),
                    resetsAt: finite(limit.window?.resetsAt) ? limit.window.resetsAt : null,
                    durationMs: finite(limit.window?.durationMs) ? limit.window.durationMs : WINDOW_MS[window],
                    fetchedAt: finite(report.fetchedAt) ? report.fetchedAt : null,
                    status: limit.status || 'unknown'}];
            });
            // A window whose only limit is model-scoped (OpenAI reports 5h for
            // Spark alone) is that account's answer for the window: promote it
            // to the shared row, tagged with where the number came from. Two or
            // more model limits without a shared one stay children; there is no
            // honest single answer to promote.
            for (const window of Object.keys(WINDOW_MS)) {
                if (limits.some(limit => limit.window === window && !limit.model)) continue;
                const scoped = limits.filter(limit => limit.window === window);
                if (scoped.length !== 1) continue;
                const [only] = scoped;
                only.tag = only.model;
                only.model = null;
                only.label = sharedLabel(window);
            }
            return {index, fetchedAt: finite(report.fetchedAt) ? report.fetchedAt : null, limits};
        });
        const allLimits = accounts.flatMap(account => account.limits);
        // For multiple signed-in accounts show the highest usage per window in the
        // compact panel. The menu retains separate anonymous account sections.
        // Model-specific limits are never substituted for a shared window limit.
        const worst = window => allLimits.filter(limit => limit.window === window && !limit.model && limit.percent !== null)
            .sort((a, b) => b.percent - a.percent)[0] || null;
        return {...provider, accounts, fiveHour: worst('5h'), weekly: worst('7d')};
    });
}

// The payload is used-based; the UI is remaining-based. Presentation inverts
// here so no caller has to do the arithmetic.
export function remainingPercent(used) {
    return finite(used) ? Math.min(100, Math.max(0, 100 - used)) : null;
}
export function remainingText(used) {
    const left = remainingPercent(used);
    if (left === null) return '—';
    if (left > 0 && left < 0.5) return '0.1%';
    if (left < 100 && left >= 99.5) return '99.9%';
    return `${Math.round(left)}%`;
}
export function countdown(resetsAt, now = Date.now()) {
    if (!finite(resetsAt)) return '—';
    const ms = resetsAt - now;
    if (ms <= 0) return 'due';
    if (ms < 60000) return '<1m';
    const minutes = Math.ceil(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}
// Share of the window that has already elapsed, so a meter can mark even pace.
// Null whenever the reset time or duration is unknown, or the window boundary
// has been crossed and the answer would land outside the rail.
export function paceFraction(limit, now = Date.now()) {
    const durationMs = limit?.durationMs;
    const resetsAt = limit?.resetsAt;
    if (!finite(durationMs) || !finite(resetsAt) || durationMs <= 0) return null;
    const fraction = (durationMs - (resetsAt - now)) / durationMs;
    return finite(fraction) && fraction > 0 && fraction < 1 ? fraction : null;
}
// Values are stale past STALE_MS, or past `staleMs` when a slow refresh
// interval makes that the longer wait.
export function freshness(fetchedAt, now = Date.now(), staleMs = STALE_MS) {
    return !finite(fetchedAt) || now - fetchedAt > staleMs;
}
// Computed from the used value the payload carries: warning at 30% or less
// left, critical at 10% or less left, or an exhausted limit.
export function threshold(value, status) {
    if (status === 'exhausted') return 'critical';
    return !finite(value) ? 'unknown' : value >= 90 ? 'critical' : value >= 70 ? 'warning' : 'normal';
}
