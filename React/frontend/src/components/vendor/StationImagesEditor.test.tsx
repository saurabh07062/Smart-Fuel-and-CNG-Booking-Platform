import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/services/api/vendorApi", () => ({ updateVendorPumpImages: vi.fn() }));

import * as api from "@/services/api/vendorApi";
import type { VendorStation } from "@/services/api/vendorApi";
import StationImagesEditor, { PUMP_IMAGE_MAX_BYTES } from "./StationImagesEditor";

const updateVendorPumpImages = vi.mocked(api.updateVendorPumpImages);

beforeAll(() => {
  // jsdom has no object URLs.
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
  URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  updateVendorPumpImages.mockResolvedValue({ msg: "Pump images updated" });
});

const station = (pumpImages?: VendorStation["pumpImages"]) =>
  ({ _id: "st1", name: "Baner Fuels", address: "Baner", status: "Active", fuelTypes: [], prices: {}, pumpImages }) as unknown as VendorStation;

const image = (name: string, type = "image/png", size = 1024) => new File([new Uint8Array(size)], name, { type });

/** Pick a file without the input's accept filter, as a browser's "All files" would. */
const pick = (label: string, file: File) => fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });

describe("Edit Station pump images", () => {
  it("offers Add Image for each photo the station does not have yet", () => {
    render(<StationImagesEditor station={station()} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText("Add Petrol Pump Image")).toBeTruthy();
    expect(screen.getByText("Add CNG Pump Image")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect((screen.getByRole("button", { name: /Save Changes/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows saved photos with Replace", () => {
    render(
      <StationImagesEditor
        station={station({ petrol: "/uploads/stations/stations-1-aaaaaaaaaaaaaaaa.png", cng: null })}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByAltText("Petrol Pump Image").getAttribute("src")).toBe(
      "/uploads/stations/stations-1-aaaaaaaaaaaaaaaa.png",
    );
    expect(screen.getByText("Replace Petrol Pump Image")).toBeTruthy();
    expect(screen.getByText("Add CNG Pump Image")).toBeTruthy();
  });

  it("previews both chosen photos and uploads them on Save", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<StationImagesEditor station={station()} onClose={onClose} onSaved={onSaved} />);

    const petrol = image("petrol.jpg", "image/jpeg");
    const cng = image("cng.webp", "image/webp");
    pick("Petrol Pump Image", petrol);
    pick("CNG Pump Image", cng);

    expect(screen.getByAltText("Petrol Pump Image").getAttribute("src")).toBe("blob:preview-1");
    expect(screen.getByAltText("CNG Pump Image").getAttribute("src")).toBe("blob:preview-2");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled(); // choosing CNG must not break the petrol preview

    await user.click(screen.getByRole("button", { name: /Save Changes/ }));
    await waitFor(() => expect(updateVendorPumpImages).toHaveBeenCalledWith("st1", { petrol, cng }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses a file that is not a JPG, PNG or WEBP image", async () => {
    render(<StationImagesEditor station={station()} onClose={() => {}} onSaved={() => {}} />);
    pick("Petrol Pump Image", image("menu.pdf", "application/pdf"));
    expect(screen.getByRole("alert").textContent).toContain("is not a JPG, PNG or WEBP image");
    pick("CNG Pump Image", image("photo.png.exe", "image/png"));
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByRole("img")).toBeNull();
    expect((screen.getByRole("button", { name: /Save Changes/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a photo over 5MB", () => {
    render(<StationImagesEditor station={station()} onClose={() => {}} onSaved={() => {}} />);
    pick("CNG Pump Image", image("big.png", "image/png", PUMP_IMAGE_MAX_BYTES + 1));
    expect(screen.getByRole("alert").textContent).toContain("larger than 5MB");
    expect(updateVendorPumpImages).not.toHaveBeenCalled();
  });

  it("keeps the editor open and says why when the server refuses", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    updateVendorPumpImages.mockRejectedValue({ response: { data: { msg: "Station not found" } } });
    render(<StationImagesEditor station={station()} onClose={onClose} onSaved={() => {}} />);
    pick("Petrol Pump Image", image("petrol.png"));
    await user.click(screen.getByRole("button", { name: /Save Changes/ }));
    await waitFor(() => expect(updateVendorPumpImages).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Save Changes/ })).toBeTruthy();
  });
});
