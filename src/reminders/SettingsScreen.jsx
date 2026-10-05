import React from "react";
import NotificationSettings from "../NotificationSettings";
import NotificationDiagnostics from "../NotificationDiagnostics";

// The settings page, moved out of Alfred.jsx unchanged apart from the
// `view === "settings"` test, which stays in Alfred around this component.
export default function SettingsScreen() {
  return (
    <div>
      <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Settings</h2>
      <NotificationSettings />
      <NotificationDiagnostics />
      <div className="mt-4 p-4 sm:p-6 bg-card border border-border rounded-lg">
        <p className="text-muted-foreground">More settings coming soon...</p>
      </div>
      {process.env.REACT_APP_BUILD_TIMESTAMP && (
        <div className="mt-6 text-xs text-muted-foreground/60">
          <p>Last deployed: {new Date(process.env.REACT_APP_BUILD_TIMESTAMP).toLocaleString()}</p>
          <p>Commit: {(process.env.REACT_APP_COMMIT_SHA || 'local').slice(0, 7)}</p>
        </div>
      )}
    </div>
  );
}
