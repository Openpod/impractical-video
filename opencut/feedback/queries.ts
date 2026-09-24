import { db, feedback } from "@opencut/db";
import { generateUUID } from "@opencut/utils/id";
import type { FeedbackEntry, SubmitFeedbackInput } from "./types";

export async function submitFeedback({
	message,
}: SubmitFeedbackInput): Promise<FeedbackEntry> {
	const id = generateUUID();
	const now = new Date();

	await db.insert(feedback).values({ id, message, createdAt: now });

	return { id, message, createdAt: now.toISOString() };
}
