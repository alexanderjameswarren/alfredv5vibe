import { Link, useLocation } from "react-router";
import { Bell, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "./ui/button";

const tabs = [
  { path: "/", label: "Home" },
  { path: "/inbox", label: "Inbox", badge: 7 },
  { path: "/contacts", label: "Contacts" },
  { path: "/schedule", label: "Schedule", badge: 7 },
  { path: "/intentions", label: "Intentions" },
  { path: "/memories", label: "Memories" },
  { path: "/collections", label: "Collections" },
  { path: "/sam", label: "Sam" },
];

export default function Header() {
  const location = useLocation();

  return (
    <header className="border-b border-border bg-card sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl text-foreground mb-1">Alfred v5</h1>
            <p className="text-sm text-muted-foreground">
              Capture decisions. Hold intent. Execute with focus.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon">
              <Bell className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon">
              <RefreshCw className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon">
              <Trash2 className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="sm">
              Sign out
            </Button>
          </div>
        </div>

        <nav className="flex gap-2">
          {tabs.map((tab) => {
            const isActive =
              tab.path === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(tab.path);
            return (
              <Link key={tab.path} to={tab.path}>
                <Button
                  variant={isActive ? "default" : "ghost"}
                  size="sm"
                  className={isActive ? "bg-primary hover:bg-primary-hover text-primary-foreground" : ""}
                >
                  {tab.label}
                  {tab.badge && (
                    <span className="ml-1.5 bg-primary-foreground text-primary rounded-full px-1.5 py-0.5 text-xs min-w-[20px] text-center">
                      {tab.badge}
                    </span>
                  )}
                </Button>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}