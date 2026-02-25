import React, { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause, Minus, Plus } from "lucide-react";

export default function AudioControls({ audioElement }) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [tempo, setTempo] = useState(1.0);
  const [tempoInput, setTempoInput] = useState("100");
  const rafRef = useRef(null);

  // Sync UI with audio element state
  useEffect(() => {
    if (!audioElement) return;

    function onPlay() { setPlaying(true); }
    function onPause() { setPlaying(false); }
    function onEnded() { setPlaying(false); }
    function onLoaded() { setDuration(audioElement.duration || 0); }

    audioElement.addEventListener("play", onPlay);
    audioElement.addEventListener("pause", onPause);
    audioElement.addEventListener("ended", onEnded);
    audioElement.addEventListener("loadedmetadata", onLoaded);
    audioElement.addEventListener("durationchange", onLoaded);

    // If already loaded
    if (audioElement.duration) setDuration(audioElement.duration);

    return () => {
      audioElement.removeEventListener("play", onPlay);
      audioElement.removeEventListener("pause", onPause);
      audioElement.removeEventListener("ended", onEnded);
      audioElement.removeEventListener("loadedmetadata", onLoaded);
      audioElement.removeEventListener("durationchange", onLoaded);
    };
  }, [audioElement]);

  // Animation frame loop for smooth currentTime updates
  useEffect(() => {
    if (!audioElement || !playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    function tick() {
      setCurrentTime(audioElement.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [audioElement, playing]);

  const togglePlay = useCallback(() => {
    if (!audioElement) return;
    if (audioElement.paused) {
      audioElement.play();
    } else {
      audioElement.pause();
    }
  }, [audioElement]);

  function handleSeek(e) {
    if (!audioElement) return;
    const time = Number(e.target.value);
    audioElement.currentTime = time;
    setCurrentTime(time);
  }

  function applyTempo(rate) {
    const clamped = Math.min(1.5, Math.max(0.5, rate));
    setTempo(clamped);
    setTempoInput(String(Math.round(clamped * 100)));
    if (audioElement) {
      audioElement.playbackRate = clamped;
      audioElement.preservesPitch = true;
    }
  }

  function handleTempoInput(e) {
    setTempoInput(e.target.value);
    const n = Number(e.target.value);
    if (n >= 50 && n <= 150) {
      const rate = n / 100;
      setTempo(rate);
      if (audioElement) {
        audioElement.playbackRate = rate;
        audioElement.preservesPitch = true;
      }
    }
  }

  function handleTempoBlur() {
    const n = Number(tempoInput);
    if (!n || n < 50) applyTempo(0.5);
    else if (n > 150) applyTempo(1.5);
    else applyTempo(n / 100);
  }

  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  if (!audioElement) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-card border border-border rounded-lg mb-3">
      <button
        onClick={togglePlay}
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded bg-primary hover:bg-primary-hover text-white transition-colors"
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>

      <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">
        {formatTime(currentTime)}
      </span>

      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onChange={handleSeek}
        className="flex-1 h-2 accent-primary cursor-pointer"
      />

      <span className="text-xs text-muted-foreground w-10 tabular-nums">
        {formatTime(duration)}
      </span>

      <div className="flex items-center gap-1">
        <button
          onClick={() => applyTempo(tempo - 0.05)}
          className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <input
          type="number"
          value={tempoInput}
          onChange={handleTempoInput}
          onBlur={handleTempoBlur}
          onFocus={(e) => e.target.select()}
          className="w-12 px-1 py-1 border border-border rounded text-xs text-center tabular-nums min-h-[44px]"
          min={50}
          max={150}
          step={5}
        />
        <button
          onClick={() => applyTempo(tempo + 0.05)}
          className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
