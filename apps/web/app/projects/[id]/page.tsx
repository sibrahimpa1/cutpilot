"use client";

import { use } from "react";
import { Workspace } from "@/components/Workspace";

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Workspace id={id} />;
}
