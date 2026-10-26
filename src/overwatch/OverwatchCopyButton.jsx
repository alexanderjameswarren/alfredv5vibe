import React from "react";
import CopyButton from "../shared/CopyButton";
import { overwatchCopyText } from "./overwatchCopy";

/**
 * The one copy control on the Overwatch tab: the shared CopyButton with Overwatch's copy text,
 * its tap target raised from 32px to 40px for phones.
 */
export default function OverwatchCopyButton({ copy, className = "" }) {
  return (
    <CopyButton
      getText={() => overwatchCopyText(copy)}
      label={`Copy ${copy.what} for an Overwatch chat`}
      title="Copy for an Overwatch chat"
      className={`!min-h-[40px] !min-w-[40px] ${className}`}
    />
  );
}
