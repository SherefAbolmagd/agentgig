import { Composition } from "remotion";
import { Demo, FPS } from "./Demo";
import timeline from "./timeline.json";

export const Root = () => (
  <Composition id="Demo" component={Demo} fps={FPS} width={1920} height={1080} durationInFrames={Math.ceil(timeline.total * FPS)} />
);
