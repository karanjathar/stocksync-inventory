import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Scanner } from '../components/Scanner';
import { StockCounts } from './StockCounts';
import { StockOperation } from './StockOperation';
import { mockApi } from '../test/setup';

const auth = vi.hoisted(() => ({ role: 'staff' as 'staff' | 'viewer' }));
vi.mock('../auth', () => ({ useAuth: () => ({ can: (r: string) => r === 'viewer' || auth.role === 'staff', user: { id: 'u', role: auth.role } }) }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'BarcodeDetector'); });

describe('Scanner', () => {
  it('submits a typed or keyboard-wedge scan on Enter, trims it, and clears the box', () => {
    const onScan = vi.fn();
    render(<Scanner onScan={onScan} />);
    const input = screen.getByLabelText('Scan or type a barcode');
    fireEvent.change(input, { target: { value: '  4006381333931 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledExactlyOnceWith('4006381333931');
    expect(input).toHaveValue('');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledTimes(1); // empty input is ignored
  });

  it('shows no camera button when the browser has no BarcodeDetector', () => {
    render(<Scanner onScan={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Scan with camera' })).not.toBeInTheDocument();
    expect(screen.getByText(/scanner|type/i)).toBeInTheDocument();
  });

  it('scans with the camera once per code (cooldown) and releases the camera when closed', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
    HTMLMediaElement.prototype.play = vi.fn(async () => {});
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class { async detect() { return [{ rawValue: 'SCAN-0001' }]; } };
    const onScan = vi.fn();
    render(<Scanner onScan={onScan} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }));
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('SCAN-0001'));
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' }, audio: false });
    await act(async () => { await sleep(700); });
    expect(onScan).toHaveBeenCalledTimes(1);          // same code seen again within the cooldown is ignored
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(stop).toHaveBeenCalled();
  });

  it('explains a refused camera permission and keeps manual entry working', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException('no', 'NotAllowedError'); }) } });
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class { async detect() { return []; } };
    const onScan = vi.fn();
    render(<Scanner onScan={onScan} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/camera/i);
    fireEvent.change(screen.getByLabelText('Scan or type a barcode'), { target: { value: 'MANUAL-001' } });
    fireEvent.keyDown(screen.getByLabelText('Scan or type a barcode'), { key: 'Enter' });
    expect(onScan).toHaveBeenCalledWith('MANUAL-001');
  });
});

const tee = { id: 'p1', sku: 'TEE', name: 'T-Shirt', barcode: '4006381333931' };
const mug = { id: 'p2', sku: 'MUG', name: 'Mug', barcode: null };
const count = (over: object = {}) => ({ id: 'c1', number: 3, warehouseId: 'w1', warehouseCode: 'MAIN', status: 'OPEN', createdAt: '2026-11-26T10:00:00Z', submittedAt: null, lineCount: 0, lines: [], ...over });
const base = () => ({
  '/stock-counts': [count()], '/warehouses': [{ id: 'w1', code: 'MAIN', name: 'Main', address: '' }], '/products': [tee, mug],
  '/stock-counts/c1': count(),
});
const scan = (code: string) => { const i = screen.getByLabelText(/Scan (or type a barcode|product barcode)/); fireEvent.change(i, { target: { value: code } }); fireEvent.keyDown(i, { key: 'Enter' }); };
const renderPage = () => render(<MemoryRouter><StockCounts /></MemoryRouter>);

describe('Stock counts page', () => {
  it('starts a count for a warehouse', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base(), 'POST /stock-counts': count() });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Warehouse'), { target: { value: 'w1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start count' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/stock-counts')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ warehouseId: 'w1' });
    expect(await screen.findByText(/Count #3/)).toBeInTheDocument();
  });

  it('adds one to a product for every scan, lets staff fix the number, and saves the lines', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base(), '/products/by-barcode/4006381333931': tee, 'PUT /stock-counts/c1/lines': count({ lineCount: 1, lines: [{ productId: 'p1', sku: 'TEE', name: 'T-Shirt', countedQuantity: 3, systemQuantity: 10, variance: -7 }] }) });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /#3/ }));
    await screen.findByLabelText('Scan or type a barcode');
    scan('4006381333931'); await screen.findByLabelText('Counted TEE');
    scan('4006381333931'); await waitFor(() => expect(screen.getByLabelText('Counted TEE')).toHaveValue(2));
    fireEvent.change(screen.getByLabelText('Counted TEE'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save counts' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ lines: [{ productId: 'p1', countedQuantity: 3 }] });
    expect(await screen.findByText('-7')).toBeInTheDocument(); // variance reported by the server
  });

  it('offers to attach an unknown barcode to a product, then counts it', async () => {
    auth.role = 'staff';
    const calls = mockApi({ ...base(), 'PATCH /products/p2': { ...mug, barcode: 'NEW-000001' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /#3/ }));
    await screen.findByLabelText('Scan or type a barcode');
    scan('new-000001');
    expect(await screen.findByText(/No product has barcode NEW-000001/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Attach to product'), { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach barcode' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/products/p2')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ barcode: 'NEW-000001' });
    expect(await screen.findByLabelText('Counted MUG')).toHaveValue(1);
  });

  it('saves then submits after confirmation', async () => {
    auth.role = 'staff';
    vi.stubGlobal('confirm', vi.fn(() => true));
    const open = count({ lineCount: 1, lines: [{ productId: 'p1', sku: 'TEE', name: 'T-Shirt', countedQuantity: 4, systemQuantity: 6, variance: -2 }] });
    const calls = mockApi({ ...base(), '/stock-counts/c1': open, 'PUT /stock-counts/c1/lines': open, 'POST /stock-counts/c1/submit': { ...open, status: 'SUBMITTED' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /#3/ }));
    fireEvent.change(await screen.findByLabelText('Counted TEE'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit count' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/stock-counts/c1/submit')).toBe(true));
    const order = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual(['PUT /stock-counts/c1/lines', 'POST /stock-counts/c1/submit']);
    expect(await screen.findByRole('status')).toHaveTextContent(/Count #3 submitted/);
  });

  it('is read-only for viewers', async () => {
    auth.role = 'viewer';
    mockApi(base());
    renderPage();
    expect(await screen.findByText('MAIN')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start count' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /#3/ }));
    expect(screen.queryByLabelText('Scan or type a barcode')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit count' })).not.toBeInTheDocument();
  });
});

describe('Stock operation barcode scan', () => {
  it('selects the product whose barcode is scanned', async () => {
    mockApi({ '/products/by-barcode/4006381333931': tee, '/products/by-barcode/NOPE-0001': new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Product not found' } }), { status: 404 }) });
    render(<StockOperation products={[tee, mug]} warehouses={[{ id: 'w1', code: 'MAIN', name: 'Main', address: '' }]} onDone={() => {}} />);
    scan('4006381333931');
    await waitFor(() => expect(screen.getByLabelText('Product')).toHaveValue('p1'));
    scan('NOPE-0001');
    expect(await within(screen.getByRole('form', { name: 'Stock operation' })).findByText(/No product has barcode NOPE-0001/)).toBeInTheDocument();
  });
});
