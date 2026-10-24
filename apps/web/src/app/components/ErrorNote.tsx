import { Alert } from "antd";
import { failureText } from "../lib/errors.ts";

export const ErrorNote = ({ error }: { error: unknown }) => <Alert type="error" showIcon message={failureText(error)} />;
