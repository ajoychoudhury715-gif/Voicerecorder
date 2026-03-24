import { handleUpload } from '@vercel/blob/client';

const MAX_CHUNK_BYTES = 20 * 1024 * 1024;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json(
      { error: 'BLOB_READ_WRITE_TOKEN is not configured on the server.' },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    const jsonResponse = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith('recordings/')) {
          throw new Error('Invalid upload destination.');
        }

        return {
          allowedContentTypes: ['audio/*'],
          maximumSizeInBytes: MAX_CHUNK_BYTES,
          addRandomSuffix: false,
        };
      },
    });

    return Response.json(jsonResponse);
  } catch (error) {
    console.error('Error creating Blob upload token:', error);

    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Could not prepare the audio upload.',
      },
      { status: 400 }
    );
  }
}
