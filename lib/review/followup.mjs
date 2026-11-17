import { previousReview } from "../store/scan.mjs";
import { takeSnapshot } from "./snapshot.mjs";

export function takeReviewSnapshot({ dataDir, ...options }) {
  return takeSnapshot({ ...options, lookupPrevious: query => previousReview(dataDir, query) });
}
