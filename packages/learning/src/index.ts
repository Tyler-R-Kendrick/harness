export { learningExtension } from "./extension.ts";
export { Learning } from "./learning.ts";
export type { Change, LearningOptions, Reasoner } from "./learning.ts";
export { MaterializedSchema, Plugins, TARGETS } from "./plugins.ts";
export type { LearningPlugin, Materialized, MaterializeInput, Materializer, PluginInfo, Teacher } from "./plugins.ts";
export { planTask } from "./ladder.ts";
export type { Evidence, LadderContext, Plan, Rung } from "./ladder.ts";
export { LESSON_KINDS, parseSettings, RecordingSchema, settingsJsonSchema, TrajectorySchema } from "./schemas.ts";
export type { Lesson, LessonKind, Recording, Settings, Trajectory, TrajectoryInput, Unit } from "./schemas.ts";
