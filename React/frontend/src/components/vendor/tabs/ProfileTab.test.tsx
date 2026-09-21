import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/api/vendorApi", () => ({
  uploadVendorProfilePhoto: vi.fn(),
  updateVendorProfile: vi.fn(),
}));
vi.mock("@/services/api/authApi", () => ({ logoutRequest: vi.fn() }));
vi.mock("@/services/socket/socket", () => ({ disconnectSocket: vi.fn(), getSocket: vi.fn(), isNewer: () => true }));

import * as api from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { useAuthStore } from "@/store/authStore";
import ProfileTab from "./ProfileTab";

const upload = vi.mocked(api.uploadVendorProfilePhoto);

const PROFILE = {
  name: "SAURABH",
  businessName: "IndianOil",
  email: "owner@example.com",
  vendorStatus: "active",
};

const image = (name: string, type = "image/png", size = 1024) => new File([new Uint8Array(size)], name, { type });
const pick = (file: File) => fireEvent.change(screen.getByLabelText("Profile photo file"), { target: { files: [file] } });

beforeEach(() => {
  vi.clearAllMocks();
  useVendorStore.setState({ profile: { ...PROFILE } });
  useAuthStore.setState({ user: { id: "v1", role: "vendor", ...PROFILE } as never, isAuthenticated: true });
});

describe("Vendor profile photo", () => {
  it("with no photo, shows the initial and an Upload Photo option", () => {
    render(<ProfileTab />);
    expect(screen.getByText("S")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Upload Photo/ })).toBeTruthy();
    expect(screen.queryByAltText("Profile photo")).toBeNull();
  });

  it("with a saved photo, shows it and offers Change Photo", () => {
    useVendorStore.setState({ profile: { ...PROFILE, profileImage: "/uploads/vendors/vendors-1-aaaaaaaaaaaaaaaa.jpg" } });
    render(<ProfileTab />);
    expect(screen.getByAltText("Profile photo").getAttribute("src")).toBe("/uploads/vendors/vendors-1-aaaaaaaaaaaaaaaa.jpg");
    expect(screen.getByRole("button", { name: /Change Photo/ })).toBeTruthy();
  });

  it("uploads a chosen photo and shows the saved one at once, in the profile and the console header", async () => {
    const saved = "/uploads/vendors/vendors-2-bbbbbbbbbbbbbbbb.png";
    upload.mockResolvedValue({ msg: "Profile updated successfully", user: { ...PROFILE, profileImage: saved } });
    render(<ProfileTab />);

    const file = image("me.png");
    pick(file);

    await waitFor(() => expect(screen.getByAltText("Profile photo").getAttribute("src")).toBe(saved));
    expect(upload).toHaveBeenCalledWith(file);
    expect(useVendorStore.getState().profile?.profileImage).toBe(saved);
    expect(useAuthStore.getState().user?.profileImage).toBe(saved);
    expect(screen.getByRole("button", { name: /Change Photo/ })).toBeTruthy();
    // The rest of the profile is untouched.
    expect(screen.getByText("IndianOil")).toBeTruthy();
  });

  it("refuses a file that is not a JPG, PNG or WEBP image, without uploading", () => {
    render(<ProfileTab />);
    pick(image("resume.pdf", "application/pdf"));
    expect(screen.getByRole("alert").textContent).toContain("is not a JPG, PNG or WEBP image");
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a photo over 5MB, without uploading", () => {
    render(<ProfileTab />);
    pick(image("huge.jpg", "image/jpeg", 5 * 1024 * 1024 + 1));
    expect(screen.getByRole("alert").textContent).toContain("larger than 5MB");
    expect(upload).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the upload is refused, and keeps the old picture", async () => {
    upload.mockRejectedValue({ response: { data: { msg: "That file is too large. The limit is 5MB." } } });
    render(<ProfileTab />);
    pick(image("me.png"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The limit is 5MB"));
    expect(screen.getByText("S")).toBeTruthy();
    expect(useAuthStore.getState().user?.profileImage).toBeUndefined();
  });
});
