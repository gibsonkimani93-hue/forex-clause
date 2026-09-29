FOREX CLAUSE AI - ENHANCED CONVERSATIONAL + VOICE UPDATE

This version keeps the existing live market engine, signal history, premium access controls,
strategy evidence, TP/SL levels, and premium-market locking.

AI improvements:
- Conversational assistant that can answer general questions instead of forcing every question into Forex.
- Recent conversation context is sent with each AI request so follow-up questions make sense.
- Less repetitive responses through explicit conversational instructions.
- Forex specialist behaviour when the user asks about dashboard markets.
- Premium mode retains deeper strategy-by-strategy signal explanations.
- The AI is instructed not to invent live market facts, indicators, news, levels, or results.

Voice improvements:
- Microphone button uses the browser's Speech Recognition API where supported.
- Spoken questions are transcribed into the AI input and automatically submitted.
- Speaker button reads AI answers aloud with the browser Speech Synthesis API.
- Each AI answer also has its own read-aloud button.
- Subtle Web Audio interaction sounds are generated locally; no audio file is required.
- Voice status messages show listening, thinking, speaking, and microphone errors.

Environment:
OPENAI_API_KEY must remain server-side.
FREE_AI_MODEL and PREMIUM_AI_MODEL remain configurable in .env.
For public deployment, keep PREMIUM_DEMO=false and connect hasPremiumAccess(req)
to the real M-Pesa/PayPal subscription entitlement before launch.

The AI is educational market information and does not guarantee trading results.
