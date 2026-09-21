package com.fuelmart.customer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** What a person types in "Change server" -> the address the app loads. */
public class ServerAddressTest {

    @Test
    public void bareIpGetsHttpAndTheBackendPort() {
        assertEquals("http://10.179.108.160:5000", MainActivity.normalise("10.179.108.160"));
        assertEquals("http://10.179.108.160:5000", MainActivity.normalise("  10.179.108.160  "));
    }

    @Test
    public void keepsAGivenPortAndScheme() {
        assertEquals("http://192.168.1.20:8080", MainActivity.normalise("192.168.1.20:8080"));
        assertEquals("http://192.168.1.20:5000", MainActivity.normalise("http://192.168.1.20:5000/app/"));
        assertEquals("https://fuel.example.com", MainActivity.normalise("https://fuel.example.com"));
        assertEquals("https://fuel.example.com:8443", MainActivity.normalise("HTTPS://fuel.example.com:8443/app"));
    }

    @Test
    public void rejectsWhatIsNotAnAddress() {
        assertNull(MainActivity.normalise(""));
        assertNull(MainActivity.normalise("   "));
        assertNull(MainActivity.normalise(null));
        assertNull(MainActivity.normalise("not an address"));
        assertNull(MainActivity.normalise("http://"));
    }
}
