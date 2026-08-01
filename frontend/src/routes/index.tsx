import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Nav } from "../components/marketing/Nav";
import { Preloader } from "../components/marketing/Preloader";
import { Hero } from "../components/marketing/Hero";
import { ScrollManifesto } from "../components/marketing/ScrollManifesto";
import { ModuleGrid } from "../components/marketing/ModuleGrid";
import { LiveStats } from "../components/marketing/LiveStats";
import { FooterCTA } from "../components/marketing/FooterCTA";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [loading, setLoading] = useState(true);

  return (
    <>
      <AnimatePresence>
        {loading && <Preloader onComplete={() => setLoading(false)} />}
      </AnimatePresence>

      <div className="noise-overlay" />
      <Nav />
      <Hero />
      <ScrollManifesto />
      <LiveStats />
      <ModuleGrid />
      <FooterCTA />
    </>
  );
}
