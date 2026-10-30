import { useParams } from 'react-router-dom';

// Where a Send to CLI link lands without the Alfred extension (spec §7.1).
// It sends nothing, reads no data and needs no sign-in.

/** The project part of a run tag (`switchboard2-h8r-s17-c4mz` -> `switchboard2-h8r`), or null. */
export function projectOfTag(tag) {
  return /^([a-z0-9_]+-[a-z0-9]+)-s\d+[a-z]?-[a-z0-9]{4}$/.exec(String(tag ?? ''))?.[1] ?? null;
}

export default function SendFromDesktop() {
  const { runTag } = useParams();
  const project = projectOfTag(runTag);
  return (
    <div className="flex items-center justify-center min-h-screen bg-primary-bg p-4">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold text-dark mb-2 text-center">Alfred</h1>
        <p className="text-sm text-muted text-center mb-6">Send to CLI</p>
        <p className="text-dark mb-4">
          This prompt can only be sent from your desktop, in Chrome with the Alfred extension.
          Open the chat there and click Send to CLI. Nothing was sent from here.
        </p>
        <div className="p-4 bg-primary-bg rounded-lg border border-primary-light text-sm">
          <p className="text-muted">Run tag</p>
          <p className="font-mono text-dark break-all mb-2">{runTag}</p>
          {project && (
            <>
              <p className="text-muted">Project</p>
              <p className="font-mono text-dark">{project}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
