import { ApiFailure } from "@squad/contract";

/** The 501 the login route gives while web login is not built. */
export const isNotReady = (e: unknown): boolean => e instanceof ApiFailure && e.status === 501;

export function failureText(e: unknown): string {
  if (!(e instanceof ApiFailure)) return "Something went wrong. Try again.";
  switch (e.body.error) {
    case "unauthenticated":
      return "You are signed out. Reload the page to sign in.";
    case "forbidden":
      return "You may not do this.";
    case "not-found":
      return "That was not found.";
    case "bad-request":
      return `The server refused the request: ${e.body.message}`;
    case "conflict":
      return `This conflicts with the current state: ${e.body.message}`;
    case "disabled":
      return `This is not available yet: ${e.body.message}`;
    default:
      return "The server had an error. Try again.";
  }
}
