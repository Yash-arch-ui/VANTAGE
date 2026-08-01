"use client";
import { type JSX, useEffect, useRef, useState } from "react";
import { motion, MotionProps } from "motion/react";

type TextScrambleProps = {
  children: string;
  duration?: number;
  speed?: number;
  characterSet?: string;
  as?: React.ElementType;
  className?: string;
  trigger?: boolean;
  onScrambleComplete?: () => void;
} & MotionProps;

const defaultChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function TextScramble({
  children,
  duration = 0.8,
  speed = 0.04,
  characterSet = defaultChars,
  className,
  as: Component = "p",
  trigger = true,
  onScrambleComplete,
  ...props
}: TextScrambleProps) {
  const MotionComponent = motion.create(Component as keyof JSX.IntrinsicElements);
  const [displayText, setDisplayText] = useState(children);
  const [isAnimating, setIsAnimating] = useState(false);
  const text = children;

  /**
   * Held so the effect can stop the animation on unmount. Without it the
   * interval outlived the component, kept calling setState, and eventually
   * fired onScrambleComplete — which in the preloader's case resolved a screen
   * that was already gone. Under StrictMode the effect runs twice and both
   * calls read the same `isAnimating` from that render, so the guard alone did
   * not prevent a second interval either.
   */
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scramble = () => {
    if (intervalRef.current !== null) return;
    setIsAnimating(true);

    const steps = duration / speed;
    let step = 0;

    const interval = setInterval(() => {
      let scrambled = "";

      // Linear progress from 0 to 1
      const t = step / steps;
      // Ease-out quartic curve: starts fast, slows down smoothly at the end
      const progress = 1 - Math.pow(1 - t, 4);

      for (let i = 0; i < text.length; i++) {
        if (text[i] === " ") {
          scrambled += " ";
          continue;
        }

        // Use the eased progress to determine if a character should be resolved
        if (progress * text.length > i) {
          scrambled += text[i];
        } else {
          scrambled += characterSet[Math.floor(Math.random() * characterSet.length)];
        }
      }

      setDisplayText(scrambled);
      step++;

      if (step > steps) {
        clearInterval(interval);
        intervalRef.current = null;
        setDisplayText(text);
        setIsAnimating(false);
        onScrambleComplete?.();
      }
    }, speed * 1000);

    intervalRef.current = interval;
  };

  useEffect(() => {
    if (!trigger) return;

    scramble();
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  return (
    <MotionComponent className={className} {...props}>
      {displayText}
    </MotionComponent>
  );
}
