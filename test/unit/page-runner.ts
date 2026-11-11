/**
 * Runs the inline scripts of a page hassemu serves in `node:vm`, against a fake window, document and
 * Companion-app bridge — the tests judge what the page DOES (which messages the app gets, when),
 * not what its text contains. Only the few DOM calls the pages make are faked: `getElementById`
 * for the elements with an `id`, their `classList` and `style`.
 */

import vm from "node:vm";

/** One faked element. */
export interface FakeElement {
  /** The element's classes, live. */
  classes: Set<string>;
  /** The element's inline style, live. */
  style: Record<string, string>;
  /** The `classList` calls the pages make. */
  classList: { contains(c: string): boolean; add(c: string): void; remove(c: string): void };
}

/** A held timer or interval. */
export interface HeldTimer {
  /** The callback the page handed over. */
  cb: () => void;
  /** The delay or period the page asked for. */
  ms: number;
}

/** Options of {@link runPage}. */
export interface PageOptions {
  /** `v1` puts a V1 bridge on the window before the scripts run; `none` leaves it off. Default `v1`. */
  bridge?: "v1" | "none";
  /** Run the iframe's `onload` BEFORE the page scripts (a cached iframe that loads first). */
  iframeLoadsFirst?: boolean;
  /** Answer of every `fetch` call. Default: a promise that never settles. */
  fetch?: () => Promise<unknown>;
}

/** A page that ran. */
export interface PageRun {
  /** The bus messages the app received, parsed, in order. */
  messages: unknown[];
  /** Every `window.setTimeout` of the page, held. */
  timers: HeldTimer[];
  /** Every `window.setInterval` of the page, held. */
  intervals: HeldTimer[];
  /** The faked elements by id. */
  elements: Map<string, FakeElement>;
  /** Run the iframe's `onload` attribute code (the iframe finished loading). */
  iframeLoad(): void;
}

/**
 * The `<script>` bodies of a page, in order.
 *
 * @param html The page.
 */
export function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

/**
 * Fake one element, with the classes and inline display the markup gives it.
 *
 * @param attrs The element's attribute text.
 */
function fakeElement(attrs: string): FakeElement {
  const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
  const classes = new Set(cls.split(/\s+/).filter(Boolean));
  const style: Record<string, string> = /style="display:none"/.test(attrs) ? { display: "none" } : {};
  return {
    classes,
    style,
    classList: {
      contains: (c: string): boolean => classes.has(c),
      add: (c: string): void => void classes.add(c),
      remove: (c: string): void => void classes.delete(c),
    },
  };
}

/**
 * Run every inline script of a page in one shared context.
 *
 * @param html The page.
 * @param opts What the window offers.
 */
export function runPage(html: string, opts: PageOptions = {}): PageRun {
  const messages: unknown[] = [];
  const timers: HeldTimer[] = [];
  const intervals: HeldTimer[] = [];
  const elements = new Map<string, FakeElement>();
  for (const m of html.matchAll(/<(?:div|iframe)\s+id="([^"]+)"([^>]*)>/g)) {
    elements.set(m[1], fakeElement(m[2]));
  }
  const onload = /<iframe[^>]*\sonload="([^"]*)"/.exec(html)?.[1];
  const window: Record<string, unknown> = {
    setTimeout: (cb: () => void, ms: number): number => timers.push({ cb, ms }),
    setInterval: (cb: () => void, ms: number): number => intervals.push({ cb, ms }),
  };
  if ((opts.bridge ?? "v1") === "v1") {
    window.externalApp = {
      externalBus: (json: string): void => void messages.push(JSON.parse(json)),
    };
  }
  const context = vm.createContext({
    window,
    document: { getElementById: (id: string): FakeElement | null => elements.get(id) ?? null },
    location: { reload: (): void => undefined },
    fetch: opts.fetch ?? ((): Promise<unknown> => new Promise(() => undefined)),
    JSON,
    Promise,
  });
  const run: PageRun = {
    messages,
    timers,
    intervals,
    elements,
    iframeLoad: (): void => {
      if (onload !== undefined) {
        vm.runInContext(onload, context);
      }
    },
  };
  if (opts.iframeLoadsFirst) {
    run.iframeLoad();
  }
  for (const script of scriptsOf(html)) {
    vm.runInContext(script, context);
  }
  return run;
}

/**
 * Let every pending promise callback run.
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
