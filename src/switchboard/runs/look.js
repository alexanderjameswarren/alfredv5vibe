import { Component, createElement as h } from 'react';
import { localTime, shortHash } from '../format';
import CopyButton from '../../shared/CopyButton';

// sb3_pages-h6v A1: the look of the Switchboard 3 run and code review pages, copied from ApprovePage.jsx. C1 (s19):
// today's approve page now takes its look from here too, and the shared formatters live in ../format.js, so neither
// file imports the other's page. Plain createElement, so the file stays .js as the plan names it.

export { localTime, shortHash };

// The buttons, as every page has them.
export const BUTTON = 'w-full sm:w-auto px-4 py-3 min-h-[44px] bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50';
export const SECOND_BUTTON = 'w-full sm:w-auto px-4 py-3 min-h-[44px] rounded-lg border border-border text-primary hover:border-primary transition-colors disabled:opacity-50';

export const RED_BAR = 'w-full bg-red-700 text-white text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-6 px-4';
export const SIMULATION_STRIP = 'w-full bg-purple-700 text-white text-center text-2xl sm:text-3xl font-bold uppercase tracking-wide py-4 px-4';
const BANNER = 'mb-4 w-full text-center text-3xl sm:text-4xl font-bold uppercase tracking-wide py-5 px-4 rounded-lg';
export const PRODUCTION_BANNER = `${BANNER} bg-orange-400 text-black`;
export const SANDBOX_BANNER = `${BANNER} bg-sky-700 text-white`;
/** C1: the approve page's red PRODUCTION FULL DATA banner (an sf_read of full data on production). */
export const RED_BANNER = `${BANNER} bg-red-700 text-white`;
/** The smaller second line inside a banner. */
export const BANNER_LINE = 'block text-lg sm:text-xl normal-case tracking-normal mt-1';
export const PANEL = 'mb-4 p-4 bg-primary-bg rounded-lg border border-primary-light text-sm text-dark';
export const PRODUCTION_PILL = 'px-2 py-0.5 rounded bg-orange-100 text-black font-mono';
export const SANDBOX_PILL = 'px-2 py-0.5 rounded bg-sky-100 text-black font-mono';
/** The "Desktop not ready" section: red means a problem; orange stays the production warning. */
export const NOT_READY_BOX = 'mb-4 p-4 bg-red-50 rounded-lg border-2 border-red-600 text-sm text-dark';
/** The code review's inline diff rows (A6): added green, removed red, unchanged plain; a marker column says which. */
// Code lines never wrap: a long line makes only its file's code box scroll sideways (A7).
export const DIFF_ROW = 'font-mono text-xs whitespace-pre';
export const DIFF_ADD = 'bg-green-50 text-black';
export const DIFF_DEL = 'bg-red-50 text-black line-through decoration-red-300';
/** A link-styled button, for "Show the whole file". */
export const LINK_BUTTON = 'text-primary underline text-sm min-h-[44px] sm:min-h-0';
/** Claude's note on the code review page: pale orange, page only. */
export const NOTE_BOX = 'mb-2 p-3 bg-orange-50 rounded-lg border border-orange-200 text-sm text-dark';
export const REASON_INPUT = 'w-full px-3 py-2 min-h-[44px] rounded-lg border border-border text-dark';
/**
 * A superseded review's inputs: greyed, dashed border, not-allowed cursor, so they read as locked. Plain classes,
 * applied only when superseded; an open review's disabled inputs just dim. The checkbox drops its native look to show it.
 */
export const LOCKED_TICK = 'appearance-none w-5 h-5 rounded border-2 border-dashed border-gray-400 bg-gray-100 checked:bg-gray-400 cursor-not-allowed';
export const LOCKED_INPUT = 'bg-gray-100 text-gray-500 border-dashed cursor-not-allowed';

/**
 * The line for the chat, to copy, as ApprovePage's ResultLine. On a real page the extension fills the hidden status and
 * wires its own post "Try again"; a simulation has no such block, so nothing there can be posted.
 */
export function ResultLine({ line, sim }) {
  return h('div', { 'data-testid': 'run-result-line' },
    h('p', { className: 'text-dark mb-2' }, sim ? 'A simulation posts nothing. This is the line a real page would send to the chat.' : 'Paste this into the Claude chat, then close this tab.'),
    h('div', { className: 'flex items-center gap-2' },
      h('code', { className: 'font-mono text-dark break-all' }, line),
      h(CopyButton, { getText: () => line, title: 'Copy this line for the chat' })),
    !sim && h('div', { 'data-switchboard-status': '', hidden: true, className: 'mt-4' },
      h('p', { 'data-switchboard-status-text': '', className: 'text-dark mb-3 break-words' }),
      h('button', { type: 'button', 'data-switchboard-retry': '', className: SECOND_BUTTON }, 'Try again')));
}

/**
 * The source a page reads through: 'real' for the run pages function, anything else is sample data. Fails closed: no
 * source, or an unknown kind, counts as a simulation, so the strip can't be dropped by leaving the source out.
 */
export const isSimulation = (source) => source?.kind !== 'real';

/** B4: a refusal from switchboard-run-pages is shown word for word; any other failure gets the page's own sentence. */
export const refusalNote = (e, tail) => (e?.name === 'RunPagesError' ? e.message : `${e instanceof Error ? e.message : String(e)} ${tail}`);

/** "PRODUCTION" or "SANDBOX" pill for one step. */
export function OrgPill({ org }) {
  const sandbox = org === 'sandbox';
  return h('span', { 'data-testid': 'run-pill', 'data-org': sandbox ? 'sandbox' : 'production', className: sandbox ? SANDBOX_PILL : PRODUCTION_PILL },
    sandbox ? 'Sandbox' : 'Production');
}

/** The orange PRODUCTION and sky SANDBOX banners, each with its second line. A page touching both shows both. */
export function OrgBanners({ production, sandbox }) {
  return h('div', null,
    production && h('div', { 'data-testid': 'run-banner-production', role: 'alert', className: PRODUCTION_BANNER },
      'Production, live client data', h('span', { className: BANNER_LINE }, production)),
    sandbox && h('div', { 'data-testid': 'run-banner-sandbox', role: 'alert', className: SANDBOX_BANNER },
      'Sandbox, test records only', h('span', { className: BANNER_LINE }, sandbox)));
}

/** "Reason for not running (optional)", as on today's page. */
export function ReasonInput({ value, onChange, disabled }) {
  return h('div', { className: 'mb-4' },
    h('label', { htmlFor: 'dont-run-reason', className: 'block text-sm text-dark mb-1' }, 'Reason for not running (optional)'),
    h('input', { id: 'dont-run-reason', type: 'text', maxLength: 200, value, disabled, onChange: (e) => onChange(e.target.value), className: REASON_INPUT }));
}

/**
 * The page frame. The SIMULATION strip comes from the source's kind, never from the data, so a sample can't drop it.
 * The red bar shows only while the page offers an Approve button (approvable). No "Approve" heading under "Alfred".
 */
/** `wide`: the code review page uses the full window, keeping today's side margins; run pages keep max-w-3xl. */
export function RunShell({ source, approvable = false, wide = false, children }) {
  const sim = isSimulation(source);
  return h('div', { className: 'min-h-screen bg-primary-bg', ...(sim ? { 'data-switchboard-simulation': '' } : {}) },
    sim && h('div', { 'data-testid': 'run-simulation', role: 'alert', className: SIMULATION_STRIP },
      'Simulation', h('span', { className: 'block text-base sm:text-lg normal-case tracking-normal mt-1' },
        'Sample data. Nothing here reaches any org.')),
    approvable && h('div', { 'data-testid': 'run-approval-required', role: 'alert', className: RED_BAR }, 'Approval required'),
    h('div', { className: 'flex justify-center p-4' },
      h('div', { 'data-testid': 'run-card', className: `w-full ${wide ? 'min-w-0' : 'max-w-3xl'} self-start p-4 sm:p-8 bg-white rounded-lg shadow-md` },
        // As today's Shell: mb-2 under "Alfred", then the mb-6 spacer where the "Approve" heading was.
        h('h1', { className: 'text-2xl font-bold text-dark mb-2 text-center' }, 'Alfred'),
        h('div', { className: 'mb-6' }),
        children)));
}

/**
 * Around the live /run/ and /review/ routes: a load or render failure shows a plain message in the run page's look,
 * with a reload button, never a blank page. No request is known here, so no strip and no Approve.
 */
export class RunErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    const reload = this.props.onReload ?? (() => window.location.reload());
    return h(RunShell, { source: { kind: 'real' } },
      h('p', { 'data-testid': 'run-load-failed', role: 'alert', className: 'text-dark mb-4' }, "This page couldn't load. Nothing has run."),
      h('button', { 'data-testid': 'run-reload', className: BUTTON, onClick: () => reload() }, 'Reload'));
  }
}
