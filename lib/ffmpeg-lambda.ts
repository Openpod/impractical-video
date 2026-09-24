/**
 * FFmpeg Lambda Client
 *
 * Helpers to invoke the shared FFmpeg Lambda (impractical-ffmpeg) from this app.
 * Uses the AWS SDK to invoke the function directly (same approach as Remotion Lambda).
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const FFMPEG_AWS_REGION =
  process.env.FFMPEG_AWS_REGION ||
  process.env.REMOTION_AWS_REGION ||
  "us-east-1";
const FFMPEG_AWS_ACCESS_KEY_ID =
  process.env.FFMPEG_AWS_ACCESS_KEY_ID ||
  process.env.REMOTION_AWS_ACCESS_KEY_ID;
const FFMPEG_AWS_SECRET_ACCESS_KEY =
  process.env.FFMPEG_AWS_SECRET_ACCESS_KEY ||
  process.env.REMOTION_AWS_SECRET_ACCESS_KEY;
const FFMPEG_FUNCTION_NAME =
  process.env.FFMPEG_FUNCTION_NAME || "impractical-ffmpeg";

let lambdaClient: LambdaClient | null = null;

function getLambdaClient(): LambdaClient {
  if (!lambdaClient) {
    if (!FFMPEG_AWS_ACCESS_KEY_ID || !FFMPEG_AWS_SECRET_ACCESS_KEY) {
      throw new Error("AWS credentials not configured for FFmpeg Lambda");
    }

    lambdaClient = new LambdaClient({
      region: FFMPEG_AWS_REGION,
      credentials: {
        accessKeyId: FFMPEG_AWS_ACCESS_KEY_ID,
        secretAccessKey: FFMPEG_AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return lambdaClient;
}

export interface LambdaResponse {
  success: boolean;
  outputUrl?: string;
  metadata?: {
    duration?: number;
    width?: number;
    height?: number;
    [k: string]: unknown;
  };
  cutTimes?: number[];
  error?: string;
  details?: string;
}

/**
 * Check if the FFmpeg Lambda is configured (has AWS credentials + function name).
 */
export function isFFmpegLambdaConfigured(): boolean {
  return !!(
    FFMPEG_AWS_ACCESS_KEY_ID &&
    FFMPEG_AWS_SECRET_ACCESS_KEY &&
    FFMPEG_FUNCTION_NAME
  );
}

/**
 * Call the FFmpeg Lambda with an operation via a direct AWS SDK invoke.
 */
async function callFFmpegLambda(
  operation: string,
  params: object,
): Promise<LambdaResponse> {
  if (!FFMPEG_AWS_ACCESS_KEY_ID || !FFMPEG_AWS_SECRET_ACCESS_KEY) {
    return {
      success: false,
      error: "FFmpeg Lambda not configured",
      details:
        "Set FFMPEG_AWS_ACCESS_KEY_ID and FFMPEG_AWS_SECRET_ACCESS_KEY (or use REMOTION_AWS_* vars)",
    };
  }

  try {
    console.log(
      `[FFmpegLambda] Invoking ${operation} on ${FFMPEG_FUNCTION_NAME}...`,
    );

    const client = getLambdaClient();

    const payload = {
      operation,
      params,
    };

    const command = new InvokeCommand({
      FunctionName: FFMPEG_FUNCTION_NAME,
      Payload: JSON.stringify(payload),
    });

    const response = await client.send(command);

    // Decode response
    const responsePayload = response.Payload
      ? JSON.parse(new TextDecoder().decode(response.Payload))
      : null;

    // Check for Lambda execution errors
    if (response.FunctionError) {
      console.error(
        `[FFmpegLambda] ${operation} Lambda error:`,
        response.FunctionError,
      );
      console.error(`[FFmpegLambda] Response payload:`, responsePayload);
      return {
        success: false,
        error: `Lambda execution failed: ${response.FunctionError}`,
        details: JSON.stringify(responsePayload),
      };
    }

    // Parse the body from API Gateway-style response, else use the direct payload
    let result: LambdaResponse;
    if (responsePayload?.body) {
      result = JSON.parse(responsePayload.body);
    } else {
      result = responsePayload;
    }

    if (!result.success) {
      console.error(`[FFmpegLambda] ${operation} failed:`, result.error);
      console.error(`[FFmpegLambda] Error details:`, result.details);
    } else {
      console.log(`[FFmpegLambda] ${operation} completed successfully`);
    }

    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[FFmpegLambda] ${operation} error:`, errorMessage);

    return {
      success: false,
      error: `FFmpeg Lambda call failed: ${errorMessage}`,
    };
  }
}

/**
 * Get video metadata (duration, dimensions, codec, etc.).
 */
export async function probeVideo(videoUrl: string): Promise<LambdaResponse> {
  return callFFmpegLambda("probe", { videoUrl });
}

/**
 * Extract a single frame from a video. When `fromEnd` is true the timestamp is
 * measured from the end of the clip (last-frame mode).
 */
export async function extractFrameRemote({
  videoUrl,
  timestamp,
  fromEnd,
}: {
  videoUrl: string;
  timestamp: number;
  fromEnd?: boolean;
}): Promise<LambdaResponse> {
  return callFFmpegLambda("extractFrame", {
    videoUrl,
    timestamp,
    fromEnd,
    outputFormat: "png",
  });
}

/**
 * Trim a video to a start time + duration.
 */
export async function trimVideoRemote({
  videoUrl,
  startTime,
  duration,
}: {
  videoUrl: string;
  startTime: number;
  duration: number;
}): Promise<LambdaResponse> {
  return callFFmpegLambda("trim", { videoUrl, startTime, duration });
}

/**
 * Detect shot boundaries via ffmpeg scene detection.
 * Returns { success, cutTimes, metadata: { duration } }.
 */
export async function detectShotsRemote({
  videoUrl,
  threshold,
}: {
  videoUrl: string;
  threshold: number;
}): Promise<LambdaResponse> {
  return callFFmpegLambda("detectShots", { videoUrl, threshold });
}

/**
 * Apply an ffmpeg filter chain to a single image.
 * Returns { success, outputUrl }.
 */
export async function filterImageRemote({
  imageUrl,
  filter,
}: {
  imageUrl: string;
  filter: string;
}): Promise<LambdaResponse> {
  return callFFmpegLambda("filterImage", { imageUrl, filter });
}
