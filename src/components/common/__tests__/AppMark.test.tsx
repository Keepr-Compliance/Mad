/**
 * Tests for AppMark component
 * Verifies the Keepr app mark renders the inline SVG with the gradient + gold dot,
 * respects size/className props, and behaves correctly for decorative vs titled use.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppMark } from "../AppMark";

describe("AppMark", () => {
  describe("rendering", () => {
    it("renders an svg with the app-mark test id", () => {
      render(<AppMark />);
      const mark = screen.getByTestId("app-mark");
      expect(mark).toBeInTheDocument();
      expect(mark.tagName.toLowerCase()).toBe("svg");
    });

    it("defaults to 32px square", () => {
      render(<AppMark />);
      const mark = screen.getByTestId("app-mark");
      expect(mark).toHaveAttribute("width", "32");
      expect(mark).toHaveAttribute("height", "32");
    });

    it("respects a custom size", () => {
      render(<AppMark size={64} />);
      const mark = screen.getByTestId("app-mark");
      expect(mark).toHaveAttribute("width", "64");
      expect(mark).toHaveAttribute("height", "64");
    });

    it("applies a custom className", () => {
      render(<AppMark className="mr-2" />);
      expect(screen.getByTestId("app-mark")).toHaveClass("mr-2");
    });
  });

  describe("brand elements", () => {
    it("renders the indigo gradient stops", () => {
      const { container } = render(<AppMark />);
      const stops = container.querySelectorAll("stop");
      const colors = Array.from(stops).map((s) => s.getAttribute("stop-color"));
      expect(colors).toContain("#4F46E5");
      expect(colors).toContain("#6D5DF0");
    });

    it("renders the gold accent dot as a circle", () => {
      const { container } = render(<AppMark />);
      const dot = container.querySelector("circle");
      expect(dot).not.toBeNull();
      expect(dot).toHaveAttribute("fill", "#F5A524");
    });

    it("renders the roofline-K glyph (custom paths, not text)", () => {
      const { container } = render(<AppMark />);
      // The K is a drawn glyph (paths), never a font character.
      expect(container.querySelector("text")).toBeNull();
      const paths = container.querySelectorAll("path");
      // Two arm strokes + one wall/gable fill.
      expect(paths).toHaveLength(3);
    });

    it("gives each instance a unique gradient id (no collision)", () => {
      const { container } = render(
        <>
          <AppMark />
          <AppMark />
        </>
      );
      const gradients = container.querySelectorAll("linearGradient");
      expect(gradients).toHaveLength(2);
      const ids = Array.from(gradients).map((g) => g.getAttribute("id"));
      expect(ids[0]).not.toEqual(ids[1]);
    });
  });

  describe("accessibility", () => {
    it("is decorative (aria-hidden) with no title", () => {
      render(<AppMark />);
      const mark = screen.getByTestId("app-mark");
      expect(mark).toHaveAttribute("aria-hidden", "true");
      expect(mark).not.toHaveAttribute("role");
    });

    it("exposes role=img and a title when titled", () => {
      render(<AppMark title="Keepr" />);
      const mark = screen.getByTestId("app-mark");
      expect(mark).toHaveAttribute("role", "img");
      expect(mark).not.toHaveAttribute("aria-hidden");
      expect(screen.getByText("Keepr")).toBeInTheDocument();
    });
  });
});
