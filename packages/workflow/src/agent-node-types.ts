import type { z } from "zod";

export type AgentNodeName =
  | "AcquisitionPlanningAgent"
  | "MoviePlanningAgent"
  | "PackageRecognitionAgent";

export interface AgentNodeSpec {
  nodeName: AgentNodeName;
  schemaName: "acquisition_planning" | "movie_planning" | "package_recognition";
  maxSteps: number;
  system: string;
  toolInputSchemas?: Record<string, z.ZodType>;
}
