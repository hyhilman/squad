import { Alert, Card, Collapse, Descriptions, Skeleton, Space, Tag, Typography } from "antd";
import { Link, useParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote.tsx";
import { outcomeBadge } from "../lib/badges.ts";
import { costText, durationText, tokensText } from "../lib/format.ts";
import { usePass } from "../queries.ts";

// Text from a pass is shown as plain text in <pre>. It is never turned into HTML.
const textBox = { margin: 0, padding: 12, maxHeight: 420, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, borderRadius: 6 } as const;

function Text({ children }: { children: string }) {
  return (
    <Typography>
      <pre style={{ ...textBox, background: "rgba(128,128,128,0.12)" }}>{children}</pre>
    </Typography>
  );
}

export function Pass() {
  const { passId = "" } = useParams();
  const q = usePass(passId);
  if (q.isLoading) return <Skeleton active />;
  if (q.isError || q.data === undefined) return <ErrorNote error={q.error ?? new Error("not loaded")} />;
  const p = q.data;
  const b = outcomeBadge(p.outcome);
  const t = p.tokens;
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Link to="/passes">Back to passes</Link>
        <Typography.Title level={3} style={{ margin: "4px 0 0" }}>
          Pass {p.passId}
        </Typography.Title>
      </div>
      <Card>
        <Descriptions column={{ xs: 1, sm: 1, md: 2 }} bordered size="small">
          <Descriptions.Item label="Started">{new Date(p.startedAt).toLocaleString()}</Descriptions.Item>
          <Descriptions.Item label="Took">{durationText(p.startedAt, p.endedAt)}</Descriptions.Item>
          <Descriptions.Item label="Account">{p.account === undefined ? "none (no account was free)" : <Link to={`/accounts/${p.account}`}>{p.account}</Link>}</Descriptions.Item>
          <Descriptions.Item label="Model">{p.model}</Descriptions.Item>
          <Descriptions.Item label="Caller">{p.caller.flow} / {p.caller.action}</Descriptions.Item>
          <Descriptions.Item label="Task">{p.task === undefined ? "none" : `${p.task.kind} ${p.task.id}`}</Descriptions.Item>
          <Descriptions.Item label="Outcome">
            <Tag color={b.color}>{b.text}</Tag>
            {p.failKind === undefined ? "" : `${p.failKind}${p.failCode === undefined ? "" : ` (${p.failCode})`}`}
          </Descriptions.Item>
          <Descriptions.Item label="Cost">{costText(p.costUsd) || "none"}</Descriptions.Item>
          <Descriptions.Item label="Tokens" span={2}>
            input {tokensText(t.input)}, output {tokensText(t.output)}, cache read {tokensText(t.cacheRead)}, cache write {tokensText(t.cacheWrite)}, reasoning {tokensText(t.reasoning)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {p.expired === true ? <Alert type="warning" showIcon message="Expired" description="The prompt or the transcript was cleaned up by age, so it is gone." /> : null}
      {p.truncated === true ? <Alert type="info" showIcon message="Truncated" description="The prompt or the transcript was cut at 256 KB." /> : null}

      {p.prompt === undefined ? null : (
        <Collapse
          defaultActiveKey={["prompt"]}
          items={[{ key: "prompt", label: "Prompt", children: <Text>{p.prompt}</Text> }]}
        />
      )}

      {p.transcript === undefined ? (
        p.expired === true ? null : <Alert type="info" message={p.hasTranscript ? "No transcript text." : "No transcript was kept for this pass."} />
      ) : (
        <Card title="Transcript">
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {p.transcript.texts.map((s, i) => (
              <Text key={i}>{s}</Text>
            ))}
            <Typography.Text strong>Final answer</Typography.Text>
            <Text>{p.transcript.final === "" ? "(empty)" : p.transcript.final}</Text>
          </Space>
        </Card>
      )}
    </Space>
  );
}
