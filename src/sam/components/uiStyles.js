// ONE LOOK FOR THE SONG PAGE (song rail, 4c). Every button and input on the
// song page — rail, title row, plan bar, tray, fingering row, More drawer, the
// Edit song dialog — takes its radius, press feedback and on-state from here.
export const UI = {
  // The radius of the Edit song dialog's inputs and the old Fingering mode button.
  radius: "rounded-lg",
  // Hover darkens a little, pressed a little more. `enabled:` keeps disabled
  // buttons still; labels (checkbox/radio toggles) use `pressLabel`.
  press: "transition duration-100 enabled:hover:brightness-95 enabled:active:brightness-90",
  pressLabel: "transition duration-100 hover:brightness-95 active:brightness-90",
  // Selected / on: light tan fill, brown border and text.
  on: "border-primary bg-primary-light text-primary",
  off: "border-border bg-card text-muted-foreground",
};
// An outlined button: shape + press + the off look; `toggle` picks on or off.
UI.button = `${UI.radius} ${UI.press} border`;
UI.outline = `${UI.button} ${UI.off}`;
UI.toggle = (isOn) => `${UI.button} ${isOn ? UI.on : UI.off}`;
UI.input = `${UI.radius} border border-border px-2 py-1 text-sm min-h-[44px]`;
