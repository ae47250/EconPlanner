import messages from "../../policy/messages/en-US.json" with { type: "json" };
import { displayMessage } from "./student-language.js";

export function summerLastResortNote() {
  return displayMessage(messages.messages, "offering.summerLastResort");
}
