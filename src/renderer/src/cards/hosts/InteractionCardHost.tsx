import type { AgentQuestionResolved } from "@shared/agent-question";
import type { DisplayEvent } from "@shared/card-display-protocol";
import type { CardHostId } from "@shared/cards/card-presentation-policy";
import {
  recordDisplayCardAction,
  useInteractionCardManager,
} from "@shared/cards/display-card-managers";
import type React from "react";
import { AgentQuestionCard } from "../../components/AgentQuestionCard";

type QuestionEvent = Extract<DisplayEvent, { kind: "interaction.question-requested" }>;

interface InteractionCardHostProps {
  host: Extract<CardHostId, "timeline" | "composer-before-input">;
  anchorMessageId?: string;
  busy: boolean;
  onResolveQuestion: (event: QuestionEvent, resolved: AgentQuestionResolved) => void;
}

/** Renders only semantic interaction events owned by the interaction manager. */
export const InteractionCardHost: React.FC<InteractionCardHostProps> = ({
  host,
  anchorMessageId,
  busy,
  onResolveQuestion,
}) => {
  const cards = useInteractionCardManager((state) => state.cards).filter(
    (card) =>
      card.policy.host === host &&
      (host !== "timeline" || card.event.scope.anchorMessageId === anchorMessageId) &&
      (host !== "composer-before-input" || card.status === "active") &&
      card.status !== "dismissed" &&
      card.status !== "superseded",
  );

  return (
    <div className="card-stack">
      {cards.map((card) => {
        const event = card.event;
        if (event.kind === "interaction.question-requested") {
          const resolved =
            card.status === "resolved" && card.lastAction?.actionId === "answer"
              ? (card.lastAction.payload as AgentQuestionResolved)
              : undefined;
          const question = event.payload.question;
          if (!question) return null;
          return (
            <AgentQuestionCard
              key={event.eventId}
              question={resolved ? { ...question, resolved } : question}
              disabled={busy || card.status !== "active"}
              onResolve={(answer) => {
                recordDisplayCardAction(event.eventId, "answer", answer, "resolved");
                onResolveQuestion(event, answer);
              }}
            />
          );
        }

        return null;
      })}
    </div>
  );
};
