import crypto from "node:crypto";
import { vi } from "vitest";

import {
  LEGACY_DISPLAY_ID,
  MODEL_PART_MAX,
  idFront,
  modelFromUserAgent,
  modelPart,
  movedDisplayId,
  newDisplayId,
  NO_MODEL,
  randomIdTail,
  withCounter,
} from "./display-id";

/** The Android app's agent as it reaches hassemu: the WebView's, with the app's own part appended (HAWebView.kt:239). */
const ANDROID_APP =
  "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.102 Safari/537.36 Home Assistant/2026.11.1-full (Android 14; Pixel Tablet)";
/** The app's own part alone — its API calls (`HomeAssistantApis.kt:41`). */
const ANDROID_API = "Home Assistant/2026.11.1-full (Android 15; SM-X710)";
/** A wall display's built-in page: the WebView's agent alone, its model reduced to `K`. */
const WEBVIEW_ONLY =
  "Mozilla/5.0 (Linux; Android 11; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/**
 * The iOS app names no model: `Home Assistant/<version> (<bundle>; build:<build>; <system> <version>)` plus
 * ` Mobile/HomeAssistant, like Safari` as the WebView's application name (iOS 2026.10.3, `HomeAssistantAPI.userAgent`,
 * `applicationNameForUserAgent`).
 */
const IOS_APP =
  "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Home Assistant/2026.10.3 (io.robbie.HomeAssistant; build:2026.1234; iPadOS 18.1.0) Mobile/HomeAssistant, like Safari";

const none = (): boolean => false;

describe("display ids (K7, krobi 2026-11-11 19:51)", () => {
  describe("modelFromUserAgent", () => {
    it("reads the model from the Android app's own part, with and without the WebView before it", () => {
      expect(modelFromUserAgent(ANDROID_APP)).toBe("Pixel Tablet");
      expect(modelFromUserAgent(ANDROID_API)).toBe("SM-X710");
    });

    it("reads nothing from the WebView's part, the iOS app or a non-string", () => {
      expect(modelFromUserAgent(WEBVIEW_ONLY)).toBeNull();
      expect(modelFromUserAgent(IOS_APP)).toBeNull();
      expect(modelFromUserAgent(undefined)).toBeNull();
      expect(modelFromUserAgent(42)).toBeNull();
      expect(modelFromUserAgent("Home Assistant/2026.11.1 (Android 14;  )")).toBeNull();
    });
  });

  describe("modelPart", () => {
    it("is lower case, letters and digits, every other run one hyphen, no hyphen at either end", () => {
      expect(modelPart("Pixel Tablet")).toBe("pixel-tablet");
      expect(modelPart("SM-X710")).toBe("sm-x710");
      expect(modelPart("  Lenovo Tab M10 (3rd Gen)  ")).toBe("lenovo-tab-m10-3rd-gen");
      expect(modelPart("Ünïcode_Pad")).toBe("n-code-pad");
      expect(modelPart("***")).toBe("");
    });

    it(`is at most ${MODEL_PART_MAX} characters and ends on no hyphen after the cut`, () => {
      const part = modelPart("Extremely Long Model Name Of A Tablet");
      expect(part.length).toBeLessThanOrEqual(MODEL_PART_MAX);
      expect(part).toBe("extremely-long-model-nam");
      expect(modelPart("abcdefghijklmnopqrstuvw x")).toBe("abcdefghijklmnopqrstuvw");
    });
  });

  describe("idFront", () => {
    it(`is the model part, or "${NO_MODEL}" when the agent names none or nothing usable`, () => {
      expect(idFront(ANDROID_APP)).toBe("pixel-tablet");
      expect(idFront(WEBVIEW_ONLY)).toBe(NO_MODEL);
      expect(idFront(IOS_APP)).toBe(NO_MODEL);
      expect(idFront(null)).toBe(NO_MODEL);
      expect(idFront("Home Assistant/1 (Android 14; ***)")).toBe(NO_MODEL);
    });
  });

  describe("withCounter", () => {
    it("is the candidate while free, else the first free counter from 2 on", () => {
      expect(withCounter("display-c3a1", none)).toBe("display-c3a1");
      const held = new Set(["display-c3a1", "display-c3a1-2"]);
      expect(withCounter("display-c3a1", id => held.has(id))).toBe("display-c3a1-3");
    });
  });

  describe("randomIdTail", () => {
    it("is four hex characters from two bytes of crypto.randomBytes", () => {
      const spy = vi.spyOn(crypto, "randomBytes").mockImplementation(() => Buffer.from([0x02, 0xb7]));
      try {
        expect(randomIdTail()).toBe("02b7");
        expect(spy).toHaveBeenCalledWith(2);
      } finally {
        spy.mockRestore();
      }
      expect(randomIdTail()).toMatch(/^[0-9a-f]{4}$/);
    });
  });

  describe("newDisplayId", () => {
    it("is the acceptance page's three examples", () => {
      expect(newDisplayId(ANDROID_APP, "02b7", none)).toBe("pixel-tablet-02b7");
      expect(newDisplayId(WEBVIEW_ONLY, "c3a1", none)).toBe("display-c3a1");
      expect(newDisplayId(IOS_APP, "77e0", none)).toBe("display-77e0");
    });

    it("gets a counter when the id is held", () => {
      expect(newDisplayId(IOS_APP, "77e0", id => id === "display-77e0")).toBe("display-77e0-2");
    });
  });

  describe("movedDisplayId and LEGACY_DISPLAY_ID", () => {
    it("moves an old id to display-<its last four characters>, with a counter when held", () => {
      expect(movedDisplayId("61c3a1", none)).toBe("display-c3a1");
      expect(movedDisplayId("bbc3a1", id => id === "display-c3a1")).toBe("display-c3a1-2");
    });

    it("knows the old form: six lower-case hex characters, nothing else", () => {
      expect(LEGACY_DISPLAY_ID.test("61c3a1")).toBe(true);
      for (const id of ["display-c3a1", "61C3A1", "61c3a", "61c3a1b", "fresh1"]) {
        expect(LEGACY_DISPLAY_ID.test(id), id).toBe(false);
      }
    });
  });
});
