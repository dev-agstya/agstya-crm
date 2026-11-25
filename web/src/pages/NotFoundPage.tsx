import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <div className="flex min-h-[70vh] w-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <p className="text-8xl font-black tracking-tight text-primary/20">
          404
        </p>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or may have been moved.
        </p>
        <div className="mt-6 flex justify-center">
          <Button asChild>
            <Link to="/dashboard">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Dashboard
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
