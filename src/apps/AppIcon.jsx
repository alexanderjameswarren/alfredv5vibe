import React from "react";
import {
  Briefcase,
  Car,
  Disc3,
  Dumbbell,
  Gamepad2,
  GraduationCap,
  House,
  LayoutGrid,
  Music,
  Timer,
  Wallet,
  Wrench,
} from "lucide-react";

// apps.icon holds a lucide name; only the names seeded in 116 are bundled.
export const APP_ICONS = {
  Briefcase,
  Car,
  Disc3,
  Dumbbell,
  Gamepad2,
  GraduationCap,
  House,
  Music,
  Timer,
  Wallet,
  Wrench,
};

/** An app's glyph by its apps.icon name; an unknown name falls back to a grid. */
export default function AppIcon({ icon, className = "w-4 h-4" }) {
  const Glyph = APP_ICONS[icon] || LayoutGrid;
  return <Glyph className={className} aria-hidden="true" />;
}
