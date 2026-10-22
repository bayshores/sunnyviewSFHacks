"use client";

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PanelSpec } from "@/components/PanelPacking";
import { apiUrl } from "@/lib/api";
import {
  DEFAULT_EXPLAIN_CAVEAT,
  errorFromResponse,
  estimateInputsKey,
  explainTextFromResponse,
  summaryBullets,
} from "./estimate";
import { asRecord } from "./geometry";
import {
  ELEVENLABS_KEY_STORAGE,
  ELEVENLABS_KEY_WITHHELD_NOTICE,
  ELEVENLABS_VOICE_STORAGE,
  localKeyHeader,
  readLocalSetting,
} from "./local-keys";
import type { Estimate, ExplainText } from "./types";

const TTS_UNAVAILABLE_MESSAGE = "Text-to-speech is not available right now.";

export type ExplainAndTalkInput = {
  opened: boolean;
  estimate: Estimate;
  lat: number | null;
  lng: number | null;
  tiltDeg: number;
  azimuthDeg: number;
  lossesPct: number;
  panelSpec: PanelSpec;
  orientationDeg: number;
  panelCount: number;
  dcKw: number;
  setActionNotice: Dispatch<SetStateAction<string | null>>;
};

export type ExplainAndTalk = {
  explainLoading: boolean;
  explainText: ExplainText | null;
  ttsLoading: boolean;
  /** null until read from localStorage after the app opens. */
  hasLocalElevenLabsKey: boolean | null;
  runExplain: () => Promise<void>;
  runTalk: () => Promise<void>;
};

/** Gemini "Explain" bullets and ElevenLabs "Talk" playback for the current design. */
export function useExplainAndTalk(input: ExplainAndTalkInput): ExplainAndTalk {
  const { opened, estimate, lat, lng, tiltDeg, azimuthDeg, lossesPct, panelSpec } = input;
  const { orientationDeg, panelCount, dcKw, setActionNotice } = input;

  const [explainLoading, setExplainLoading] = useState(false);
  // Explain text is tied to the site/layout it was generated for and hidden once those change.
  const explainKey = `${estimateInputsKey({ lat, lng, tiltDeg, azimuthDeg, lossesPct }, dcKw)}|${panelCount}|${orientationDeg}|${panelSpec.wattW}`;
  const [explainState, setExplainState] = useState<{ key: string; text: ExplainText } | null>(null);
  const explainText = explainState && explainState.key === explainKey ? explainState.text : null;
  const hasSite = Number.isFinite(lat ?? NaN) && Number.isFinite(lng ?? NaN);
  useEffect(() => {
    if (!hasSite) setExplainState(null);
  }, [hasSite]);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [hasLocalElevenLabsKey, setHasLocalElevenLabsKey] = useState<boolean | null>(null);

  useEffect(() => {
    if (!opened) {
      setHasLocalElevenLabsKey(null);
      return;
    }

    const read = () => {
      setHasLocalElevenLabsKey(readLocalSetting(ELEVENLABS_KEY_STORAGE).length > 0);
    };

    read();
    const t = window.setTimeout(read, 260);
    return () => window.clearTimeout(t);
  }, [opened]);

  async function runExplain() {
    const requestKey = explainKey;
    const store = (text: ExplainText) => setExplainState({ key: requestKey, text });
    setExplainLoading(true);
    setActionNotice(null);
    try {
      const res = await fetch(apiUrl("/api/explain"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          estimate,
          assumptions: {
            siteSpec: { lat, lng, tiltDeg, azimuthDeg, lossesPct },
            panelSpec,
            orientationDeg,
            panelCount,
            dcKw,
          },
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(errorFromResponse(data, `Explain failed (${res.status})`));
      }
      store(explainTextFromResponse(data, { panelCount, dcKw, estimate }));
    } catch {
      store({
        bullets: summaryBullets(panelCount, dcKw, estimate),
        caveat: DEFAULT_EXPLAIN_CAVEAT,
      });
    } finally {
      setExplainLoading(false);
    }
  }

  async function runTalk() {
    const text =
      explainText?.bullets?.join(" ") ??
      `This layout fits ${panelCount} panels (${dcKw.toFixed(1)} kilowatts DC) and produces about ${Math.round(estimate.annualKwh).toLocaleString()} kilowatt-hours per year.`;
    setTtsLoading(true);
    setActionNotice(null);
    try {
      const elevenLabsKey = localKeyHeader(ELEVENLABS_KEY_STORAGE, "x-elevenlabs-api-key");
      setHasLocalElevenLabsKey(elevenLabsKey.hasKey);
      if (elevenLabsKey.forwarding === "withhold") {
        setActionNotice(ELEVENLABS_KEY_WITHHELD_NOTICE);
      }

      const voiceId = readLocalSetting(ELEVENLABS_VOICE_STORAGE);

      const res = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "content-type": "application/json", ...elevenLabsKey.headers },
        body: JSON.stringify({ text, voiceId: voiceId || undefined }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(errorFromResponse(data, `Text-to-speech failed (${res.status})`));
      }
      const rec = asRecord(data);
      const audioUrl = typeof rec?.audioUrl === "string" ? rec.audioUrl : null;
      if (!audioUrl) {
        setActionNotice(typeof rec?.note === "string" ? rec.note : TTS_UNAVAILABLE_MESSAGE);
        return;
      }
      const audio = new Audio(audioUrl);
      await audio.play();
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : TTS_UNAVAILABLE_MESSAGE);
    } finally {
      setTtsLoading(false);
    }
  }

  return { explainLoading, explainText, ttsLoading, hasLocalElevenLabsKey, runExplain, runTalk };
}
