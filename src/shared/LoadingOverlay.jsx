import React from "react";

export default function LoadingOverlay({ message }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-8 flex flex-col items-center gap-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        <p className="text-foreground font-medium">{message || 'Loading...'}</p>
      </div>
    </div>
  );
}
