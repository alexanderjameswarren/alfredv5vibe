import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Badge } from "../components/ui/badge";

interface Collection {
  id: string;
  name: string;
  type: "tasks" | "chores" | "recipes" | "workouts";
  items: CollectionItem[];
}

interface CollectionItem {
  id: string;
  name: string;
  completed?: boolean;
  dueDate?: string;
}

const mockCollections: Collection[] = [
  {
    id: "1",
    name: "Weekly Chores",
    type: "chores",
    items: [
      { id: "1", name: "Clean kitchen", completed: true },
      { id: "2", name: "Vacuum living room", completed: false },
      { id: "3", name: "Water plants", completed: false },
    ],
  },
  {
    id: "2",
    name: "Favorite Recipes",
    type: "recipes",
    items: [
      { id: "1", name: "Pasta Carbonara" },
      { id: "2", name: "Chicken Tikka Masala" },
      { id: "3", name: "Chocolate Chip Cookies" },
    ],
  },
  {
    id: "3",
    name: "Morning Workout",
    type: "workouts",
    items: [
      { id: "1", name: "Push-ups x20", completed: true },
      { id: "2", name: "Squats x30", completed: true },
      { id: "3", name: "Plank 60s", completed: false },
    ],
  },
  {
    id: "4",
    name: "Project Tasks",
    type: "tasks",
    items: [
      { id: "1", name: "Review design mockups", dueDate: "Feb 22" },
      { id: "2", name: "Update documentation", dueDate: "Feb 24" },
      { id: "3", name: "Test new features", dueDate: "Feb 25" },
    ],
  },
];

const collectionTypeColors = {
  tasks: "bg-[#B5D4CF] text-[#1A3C3C]",
  chores: "bg-[#7A9B9B] text-white",
  recipes: "bg-[#D4B8A8] text-[#4A3F35]",
  workouts: "bg-[#9B7E6E] text-white",
};

export default function Collections() {
  const [collections, setCollections] = useState<Collection[]>(mockCollections);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl">Collections</h2>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Collection
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Collection</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div>
                <label className="block text-sm mb-2">Name</label>
                <Input placeholder="Collection name" />
              </div>
              <div>
                <label className="block text-sm mb-2">Type</label>
                <Select>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tasks">Tasks</SelectItem>
                    <SelectItem value="chores">Chores</SelectItem>
                    <SelectItem value="recipes">Recipes</SelectItem>
                    <SelectItem value="workouts">Workouts</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setIsDialogOpen(false)}>Create</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {collections.map((collection) => (
          <Card key={collection.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{collection.name}</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="secondary"
                    className={collectionTypeColors[collection.type]}
                  >
                    {collection.type}
                  </Badge>
                  <Button variant="ghost" size="icon">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {collection.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between py-2 px-3 hover:bg-secondary/50 rounded"
                  >
                    <div className="flex items-center gap-3">
                      {item.completed !== undefined && (
                        <input
                          type="checkbox"
                          checked={item.completed}
                          className="w-4 h-4 rounded border-border accent-primary"
                          onChange={() => {}}
                        />
                      )}
                      <span
                        className={
                          item.completed ? "line-through text-muted-foreground" : ""
                        }
                      >
                        {item.name}
                      </span>
                    </div>
                    {item.dueDate && (
                      <span className="text-xs text-muted-foreground">
                        {item.dueDate}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <Button variant="ghost" size="sm" className="w-full mt-4">
                <Plus className="h-4 w-4 mr-2" />
                Add Item
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}