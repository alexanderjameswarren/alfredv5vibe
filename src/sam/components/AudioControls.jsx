import React, { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause } from "lucide-react";

export default function AudioControls({ audioElement, playbackState }) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
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

  function formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  if (!audioElement || playbackState !== "stopped") return null;

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

      <span className="text-sm font-mono font-medium text-foreground tabular-nums whitespace-nowrap">
        {Math.round(currentTime * 1000)} ms
      </span>
    </div>
  );
}
