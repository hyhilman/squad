import { ApiFailure } from "@squad/contract";

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
    case "too-many":
      return "Too many tries. Wait a minute, then try again.";
    case "disabled":
      return `This is not available yet: ${e.body.message}`;
    default:
      return "The server had an error. Try again.";
  }
}
