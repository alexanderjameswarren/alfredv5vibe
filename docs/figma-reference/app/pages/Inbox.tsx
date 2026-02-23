import { useState } from "react";
import { ChevronDown, ChevronUp, Edit, Trash2, Archive } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Badge } from "../components/ui/badge";

interface InboxItemData {
  id: string;
  title: string;
  date: string;
  context?: string;
  tags?: string[];
  enriched?: boolean;
}

const mockInboxItems: InboxItemData[] = [
  {
    id: "1",
    title: "Blow away pigeon feathers",
    date: "Wed Feb 19 at 2:35 AM",
    tags: ["outdoor-maintenance", "cleaning"],
    enriched: true,
  },
  {
    id: "2",
    title: "Use Claude to take photos of all artwork in Alex office and suggest artwork for the empty space",
    date: "Sat Feb 14 at 7:51 AM",
    context: "source",
  },
  {
    id: "3",
    title: "Set up wireless charging",
    date: "Sat Feb 14 at 6:40 AM",
  },
  {
    id: "4",
    title: "Ask chatgpt how to arrange my pots and what I should plant in the orange one",
    date: "Sun Feb 16 at 4:02 AM",
  },
  {
    id: "5",
    title: "Call the plumber tomorrow",
    date: "Yesterday at 11:28 PM",
    enriched: true,
    context: "source",
  },
  {
    id: "6",
    title: "Make pasta tonight",
    date: "Yesterday at 10:43 PM",
    enriched: true,
    context: "source",
  },
  {
    id: "7",
    title: "Add milk to grocery list",
    date: "Yesterday at 10:49 PM",
    enriched: true,
    context: "source",
  },
];

export default function Inbox() {
  const [expandedId, setExpandedId] = useState<string | null>("1");
  const [captureText, setCaptureText] = useState("");

  const handleCapture = () => {
    if (captureText.trim()) {
      console.log("Capturing:", captureText);
      setCaptureText("");
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 pb-32">
      <h2 className="text-2xl mb-6">Inbox</h2>

      <div className="space-y-3">
        {mockInboxItems.map((item) => (
          <div
            key={item.id}
            className="border border-border rounded-lg bg-card overflow-hidden"
          >
            <button
              onClick={() =>
                setExpandedId(expandedId === item.id ? null : item.id)
              }
              className="w-full px-6 py-4 flex items-start justify-between hover:bg-secondary/50 transition-colors text-left"
            >
              <div className="flex-1">
                <h3 className="text-base mb-1">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.date}</p>
              </div>
              <div className="flex items-center gap-3">
                {item.enriched && (
                  <span className="text-xs text-primary">✦ Enriched (low-el)</span>
                )}
                {item.context && (
                  <span className="text-xs text-muted-foreground">{item.context}</span>
                )}
                <button className="text-muted-foreground hover:text-foreground">
                  <Edit className="h-4 w-4" />
                </button>
                {expandedId === item.id ? (
                  <ChevronUp className="h-5 w-5" />
                ) : (
                  <ChevronDown className="h-5 w-5" />
                )}
              </div>
            </button>

            {expandedId === item.id && (
              <div className="px-6 pb-6 pt-2 border-t border-border">
                <ExpandedInboxForm item={item} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Fixed Capture Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-background border-t border-border shadow-lg z-50">
        <div className="max-w-4xl mx-auto px-6 py-4 flex gap-3">
          <Input
            placeholder="Capture anything..."
            value={captureText}
            onChange={(e) => setCaptureText(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && handleCapture()}
            className="flex-1 bg-card border-border"
          />
          <Button onClick={handleCapture}>Capture</Button>
        </div>
      </div>
    </div>
  );
}

function ExpandedInboxForm({ item }: { item: InboxItemData }) {
  const [tags, setTags] = useState<string[]>(item.tags || []);
  const [tagInput, setTagInput] = useState("");

  const addTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()]);
      setTagInput("");
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  return (
    <div className="space-y-6">
      {/* Intention Section */}
      <div className="space-y-4">
        <button className="flex items-center gap-2 text-sm">
          <ChevronDown className="h-4 w-4" />
          <span>Intention</span>
        </button>

        <div className="pl-6 space-y-4">
          <div>
            <label className="block text-sm mb-2">Name</label>
            <Input defaultValue={item.title} className="bg-input-background" />
          </div>

          <div>
            <label className="block text-sm mb-2">Linked Context (optional)</label>
            <Input placeholder="Search for a contact..." className="bg-input-background" />
            <Select>
              <SelectTrigger className="w-full mt-2 bg-input-background">
                <SelectValue placeholder="Selected: Home" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="home">Home</SelectItem>
                <SelectItem value="work">Work</SelectItem>
                <SelectItem value="personal">Personal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm mb-2">Linked Item (optional)</label>
            <p className="text-xs text-muted-foreground mb-2">
              -- new item will auto-link
            </p>
            <Input placeholder="Search for an item..." className="bg-input-background" />
          </div>

          <div>
            <label className="block text-sm mb-2">Recurrence</label>
            <Select>
              <SelectTrigger className="w-full bg-input-background">
                <SelectValue placeholder="One time" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">One time</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm mb-2">Tags</label>
            <Input
              placeholder="Add tags (comma separated)"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              className="bg-input-background"
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="bg-accent text-accent-foreground"
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="ml-1 hover:text-destructive"
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          </div>

          <button className="flex items-center gap-2 text-sm text-primary">
            <ChevronDown className="h-4 w-4" />
            <span>Schedule Event</span>
          </button>
        </div>
      </div>

      {/* Item Section */}
      <div className="space-y-4">
        <button className="flex items-center gap-2 text-sm">
          <ChevronDown className="h-4 w-4" />
          <span>Item</span>
        </button>

        <div className="pl-6 space-y-4">
          <div>
            <label className="block text-sm mb-2">Name</label>
            <Input defaultValue={item.title} className="bg-input-background" />
          </div>

          <div>
            <label className="block text-sm mb-2">Description</label>
            <Textarea
              placeholder="Optional description"
              className="bg-input-background resize-none"
              rows={3}
            />
          </div>

          <div>
            <label className="block text-sm mb-2">Context</label>
            <Select>
              <SelectTrigger className="w-full bg-input-background">
                <SelectValue placeholder="Home" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="home">Home</SelectItem>
                <SelectItem value="work">Work</SelectItem>
                <SelectItem value="personal">Personal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm mb-2">Elements</label>
            <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
              <button className="text-sm text-muted-foreground hover:text-foreground">
                + Add Element
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm mb-2">Tags</label>
            <Input
              placeholder="Add tags (comma separated)"
              className="bg-input-background"
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="bg-success-light text-success-hover"
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="ml-1 hover:text-destructive"
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Add to Collection Section */}
      <div className="space-y-4">
        <button className="flex items-center gap-2 text-sm">
          <ChevronDown className="h-4 w-4" />
          <span>Add to Collection</span>
        </button>

        <div className="pl-6 space-y-4">
          <div>
            <label className="block text-sm mb-2">Collection</label>
            <Select>
              <SelectTrigger className="w-full bg-input-background">
                <SelectValue placeholder="Select collection..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tasks">Tasks</SelectItem>
                <SelectItem value="chores">Chores</SelectItem>
                <SelectItem value="recipes">Recipes</SelectItem>
                <SelectItem value="workouts">Workouts</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm mb-2">
              Item <span className="text-muted-foreground">-- new item will be added</span>
            </label>
            <Input placeholder="Search for an item..." className="bg-input-background" />
          </div>

          <div>
            <label className="block text-sm mb-2">Quantity</label>
            <Input type="number" defaultValue="1" className="bg-input-background" />
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-between pt-4 border-t border-border">
        <Button variant="outline" className="text-muted-foreground">
          Archive
        </Button>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="bg-primary hover:bg-primary-hover text-white"
          >
            Re-enrich (Open)
          </Button>
          <Button className="bg-success hover:bg-success-hover text-white">Save</Button>
          <Button variant="outline">Cancel</Button>
        </div>
      </div>
    </div>
  );
}