import os
import tempfile
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

def transcribe_audio(audio_path):
    with open(audio_path, "rb") as audio_file:
        response = client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            response_format="text",
        )
    return response.strip()

def summarize_transcript(transcript):
    prompt = """
You are an expert meeting-notes assistant.
Given a raw spoken transcript, produce a structured summary with exactly three sections:

## Action Items
A numbered list of concrete tasks, owners (if mentioned), and deadlines (if mentioned).
If none are mentioned, write "None identified."

## Key Decisions
A numbered list of decisions that were made or agreed upon during the conversation.
If none are mentioned, write "None identified."

## Concise Overview
Two to four sentences capturing the main topic, context, and outcome of the conversation.

Keep the language professional and concise. Do not add anything outside these three sections.
""".strip()

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"Transcript:\n\n{transcript}"},
        ],
        temperature=0.3,
    )
    return response.choices[0].message.content.strip()

def handler(request):
    if request.method != 'POST':
        return {'statusCode': 405, 'body': 'Method not allowed'}

    # Get the audio file from the request
    audio_file = request.files.get('audio')
    if not audio_file:
        return {'statusCode': 400, 'body': 'No audio file provided'}

    # Save to temp file
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_file.read())
        tmp_path = tmp.name

    try:
        # Transcribe
        transcript = transcribe_audio(tmp_path)
        if not transcript:
            return {'statusCode': 400, 'body': 'No transcript generated'}

        # Summarize
        summary = summarize_transcript(transcript)

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': {
                'transcript': transcript,
                'summary': summary
            }
        }
    except Exception as e:
        return {'statusCode': 500, 'body': str(e)}
    finally:
        os.remove(tmp_path)