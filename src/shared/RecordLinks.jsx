import React from "react";
import ObjectIcon from "./ObjectIcon";
import EventMetaLink from "../schedule/EventMetaLink";

/**
 * The small row of links to a record's relatives: context pill, then the
 * intention, item and execution, each led by its type icon. Lifted from the
 * execution page header (Restructure P1) so that page, intention detail, item
 * detail and every note's source line link the same way.
 *
 * Each entry is `{ name, onOpen }`, or omitted. The execution is icon only
 * (`{ onOpen, title }`): there is no name to give it. An entry with no
 * `onOpen` renders as plain text (the context pill) or not at all.
 */
export default function RecordLinks({ context, intention, item, execution, className = "" }) {
  if (!context && !intention && !item && !execution) return null;
  return (
    <span className={`inline-flex items-center gap-x-3 gap-y-1 flex-wrap text-xs ${className}`} aria-label="Linked records">
      {context &&
        (context.onOpen ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              context.onOpen();
            }}
            title={`Open context: ${context.name}`}
            className="inline-flex items-center gap-1 bg-warning-light hover:bg-warning text-foreground px-2 py-1 rounded transition-colors"
          >
            <ObjectIcon type="context" className="w-3.5 h-3.5" />
            {context.name}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 bg-warning-light text-foreground px-2 py-1 rounded">
            <ObjectIcon type="context" className="w-3.5 h-3.5" />
            {context.name}
          </span>
        ))}
      {intention?.onOpen && (
        <EventMetaLink
          icon={<ObjectIcon type="intention" className="w-3.5 h-3.5" />}
          name={intention.name}
          showName
          onClick={intention.onOpen}
          title={`Open intention: ${intention.name}`}
        />
      )}
      {item?.onOpen && (
        <EventMetaLink
          icon={<ObjectIcon type="item" className="w-3.5 h-3.5" />}
          name={item.name}
          showName
          onClick={item.onOpen}
          title={`Open item: ${item.name}`}
        />
      )}
      {execution?.onOpen && (
        <EventMetaLink
          icon={<ObjectIcon type="execution" className="w-3.5 h-3.5" />}
          onClick={execution.onOpen}
          title={execution.title || "Open execution"}
        />
      )}
    </span>
  );
}
