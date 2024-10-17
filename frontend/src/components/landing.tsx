import { CardTitle, CardDescription, CardHeader, CardContent, Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import axios from "axios";

const BACKEND_UPLOAD_URL = "https://upload-service-hg46.onrender.com";

export function Landing() {
  const [repoUrl, setRepoUrl] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [building, setBuilding] = useState(false); // To track the "building" status
  const [buttonVisible] = useState(true); // Track button visibility

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="flex space-x-4"> {/* Container for both cards */}
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">Deploy your GitHub Repository</CardTitle>
            <CardDescription>Enter the URL of your GitHub repository to deploy it</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="github-url">GitHub Repository URL</Label>
                <Input 
                  onChange={(e) => {
                    setRepoUrl(e.target.value);
                  }} 
                  placeholder="https://github.com/username/repo" 
                />
              </div>
              {buttonVisible && (
                <Button 
                  onClick={async () => {
                    setUploading(true);
                    const res = await axios.post(`${BACKEND_UPLOAD_URL}/deploy`, { repoUrl });
                    setUploadId(res.data.id);
                    setUploading(false);
                    setBuilding(true); // Start building

                    const interval = setInterval(async () => {
                      const response = await axios.get(`${BACKEND_UPLOAD_URL}/status?id=${res.data.id}`);

                      if (response.data.status === "deployed") {
                        clearInterval(interval);
                        setBuilding(false); 
                        setDeployed(true);  
                      }
                    }, 3000);
                  }} 
                  disabled={uploadId !== "" || uploading} 
                  className="w-full" 
                  type="submit"
                >
                  {uploadId ? `Deploying (${uploadId})` : uploading ? "Uploading..." : "Upload"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {((uploading || building) && !deployed) && (
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl">Building...</CardTitle>
              <CardDescription>Building cloned repository, making dist available</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-2">
                <div className="loader animate-spin border-t-transparent border-4 border-gray-300 rounded-full w-5 h-5"></div>
                <span className="text-gray-600">Please wait...</span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {deployed && (
        <Card className="w-full max-w-md mt-8">
          <CardHeader>
            <CardTitle className="text-xl">Deployment Status</CardTitle>
            <CardDescription>Your website is successfully deployed!</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="deployed-url">Deployed URL</Label>
              <Input id="deployed-url" readOnly type="url" value={`http://${uploadId}.deployrrr.onrender.com/index.html`} />
            </div>
            <br />
            <Button className="w-full" variant="outline">
              <a href={`http://${uploadId}.deployrrr.onrender.com/index.html`} target="_blank">
                Visit Website
              </a>
            </Button>
          </CardContent>
        </Card>
      )}

      <style>{`
        .loader {
          border-width: 4px;
          border-style: solid;
          border-color: transparent;
          border-top-color: gray;
          border-radius: 50%;
        }
      `}</style>
    </main>
  );
}
