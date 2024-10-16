import { S3 } from "aws-sdk";
import fs from "fs";

const s3 = new S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION, // Optional, specify your region if needed
});

// fileName => output/12312/src/App.jsx
// filePath => /Users/harkiratsingh/vercel/dist/output/12312/src/App.jsx
export const uploadFile = async (fileName: string, localFilePath: string) => {
    if (!fs.existsSync(localFilePath)) {
        throw new Error(`File not found at path: ${localFilePath}`);
    }
    const fileContent = fs.readFileSync(localFilePath);
    const response = await s3.upload({
        Body: fileContent,
        Bucket: "deployerrr-outputs",
        Key: fileName,
    }).promise();
    console.log(response);
}