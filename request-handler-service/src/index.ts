import express from "express";
import { S3 } from "aws-sdk";
import cors from "cors";

const s3 = new S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION, 
});

const app = express();
app.use(cors());

const contentTypeMap: { [key: string]: string } = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json",
    // Add more as needed
};

app.get("/*", async (req, res) => {
    const host = req.hostname;
    const id = host.split(".")[0];
    const filePath = req.path;

    try {
        const contents = await s3.getObject({
            Bucket: "deployerrr-outputs",
            Key: `dist/${id}${filePath}`
        }).promise();

        const ext = filePath.slice(((filePath.lastIndexOf(".") - 1) >>> 0) + 2);
        const contentType = contentTypeMap[ext] || "application/octet-stream";

        res.set("Content-Type", contentType);
        // Ensure Content-Disposition is not forcing download
        res.set("Content-Disposition", "inline");

        res.send(contents.Body);
    } catch (error) {
        console.error(error);
        res.status(404).send("File not found");
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
