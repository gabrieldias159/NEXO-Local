import {genkit} from 'genkit';
import {googleAI} from '@genkit-ai/google-genai';
import {resolveGeminiApiKey} from '@/ai/api-key';

export const ai = genkit({
  plugins: [
    googleAI({
      apiKey: resolveGeminiApiKey(),
    }),
  ],
});
