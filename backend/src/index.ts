import { GoogleGenAI } from "@google/genai";

// Initialize the SDK client (automatically reads GEMINI_API_KEY)
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY});

async function generateExplanation() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Explain in 1 sentence how EVM gas estimation works.",
    });

    console.log("Gemini Output:", response.text);
  } catch (error) {
    console.error("API Call Failed:", error);
  }
}

generateExplanation();